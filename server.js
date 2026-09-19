require("dotenv").config();

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const pino = require("pino");

const { GoogleGenAI } = require("@google/genai");
const { Groq } = require("groq-sdk");

const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");

const app = express();
app.use(express.json({ limit: "2mb" }));
const PORT = process.env.PORT || 10000;

// =====================================================
// CONFIG
// =====================================================

const OWNER_NUMBER      = "233547100951";
const FALLBACK_DELAY_MS = 1 * 60 * 1000;
const AUTH_FOLDER_MAIN  = "./baileys_auth";
const AUTH_FOLDER_SEC   = "./baileys_auth_second";

// =====================================================
// BLOCKED NUMBERS
// =====================================================

const BLOCKED_NUMBERS = {
  main:   ["233599779237","233550901484","233599599254","233243682726"],
  second: ["233535840183","233267103209","233547100951"]
};

// =====================================================
// BAILEYS SESSIONS
// =====================================================

const baileysSessions = {
  main:   { phone: "233547100951", qr: null, connected: false, sock: null },
  second: { phone: "233533161186", qr: null, connected: false, sock: null }
};

// =====================================================
// LID → PHONE MAPPING (fixes @lid JID issue)
// =====================================================

const lidToPhone = new Map();

function saveLidMapping(lid, phone) {
  if (!lid || !phone) return;
  const cleanLid   = lid.replace("@lid", "").replace("@s.whatsapp.net", "");
  const cleanPhone = normalizePhone(phone);
  if (cleanLid && cleanPhone) {
    lidToPhone.set(cleanLid, cleanPhone);
    console.log(`🗂️  LID mapped: ${cleanLid} → +${cleanPhone}`);
  }
}

function phoneFromLid(lid) {
  if (!lid) return null;
  const cleanLid = lid.replace("@lid", "").replace("@s.whatsapp.net", "");
  return lidToPhone.get(cleanLid) || null;
}

// =====================================================
// META CONFIG
// =====================================================

const WHATSAPP_ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_VERIFY_TOKEN    = process.env.WHATSAPP_VERIFY_TOKEN;

// =====================================================
// AI CONFIG  ← FIXED MODEL NAMES
// =====================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;

const GEMINI_MODEL = "gemini-2.5-flash";      // ✅ fixed
const GROQ_MODEL   = "llama-3.3-70b-versatile";       // ✅ fixed

const genAI = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;
const groq   = GROQ_API_KEY  ? new Groq({ apiKey: GROQ_API_KEY })          : null;

// =====================================================
// MEMORY
// =====================================================

const personalChats = new Map();
const metaChats     = new Map();

function getPersonalChat(phone) {
  if (!personalChats.has(phone)) {
    personalChats.set(phone, {
      messages: [],
      ownerReplied: false,
      botActive: false,
      fallbackTimer: null,
      lastCustomerMessage: null,
      lastJid: null,
      jids: new Set(),
      leadNotified: false,
      lead: { name: null, business: null, businessType: null, requirement: null }
    });
  }
  return personalChats.get(phone);
}

function getMetaChat(phone) {
  if (!metaChats.has(phone)) {
    metaChats.set(phone, {
      messages: [],
      lastCustomerMessage: null,
      botActive: false,
      leadNotified: false,
      lead: { name: null, business: null, businessType: null, requirement: null }
    });
  }
  return metaChats.get(phone);
}

// =====================================================
// NORMALIZE PHONE
// =====================================================

function normalizePhone(value) {
  if (!value) return null;
  return String(value)
    .replace(/@s\.whatsapp\.net/g, "")
    .replace(/@lid/g, "")
    .replace(/@c\.us/g, "")
    .replace(/\D/g, "");
}

// =====================================================
// BLOCK CHECK
// =====================================================

function isBlockedForSession(sessionKey, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const blocked = BLOCKED_NUMBERS[sessionKey] || [];
  return blocked.some((number) => {
    const b = normalizePhone(number);
    return normalized === b || normalized.endsWith(b) || b.endsWith(normalized);
  });
}

// =====================================================
// EXTRACT MESSAGE TEXT
// =====================================================

function extractMessageText(message) {
  if (!message) return "";
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;
  if (message.buttonsResponseMessage?.selectedDisplayText) return message.buttonsResponseMessage.selectedDisplayText;
  if (message.listResponseMessage?.title) return message.listResponseMessage.title;
  if (message.listResponseMessage?.singleSelectReply?.selectedRowId) return message.listResponseMessage.singleSelectReply.selectedRowId;
  if (message.templateButtonReplyMessage?.selectedDisplayText) return message.templateButtonReplyMessage.selectedDisplayText;
  if (message.ephemeralMessage?.message) return extractMessageText(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return extractMessageText(message.viewOnceMessage.message);
  return "";
}

// =====================================================
// SAVE MESSAGE
// =====================================================

function saveMessage(chat, role, content) {
  if (!content) return;
  chat.messages.push({ role, content, timestamp: Date.now() });
  if (chat.messages.length > 30) chat.messages = chat.messages.slice(-30);
}

// =====================================================
// LEAD DETECTION
// =====================================================

function detectInterest(text) {
  if (!text) return false;
  const msg = text.toLowerCase().trim();
  const phrases = [
    "i'm interested","im interested","i am interested",
    "i want one","i need one","i want a bot","i need a bot",
    "i want you to build","i need you to build",
    "build one for me","build it for me","can you build one",
    "i want to get started","how can i get started",
    "let's do it","lets do it","i need your service","how much is it"
  ];
  return phrases.some((p) => msg.includes(p));
}

// =====================================================
// UPDATE LEAD INFO
// =====================================================

function updateLeadInformation(chat, text) {
  if (!text) return;
  const msg = text.toLowerCase();
  if (msg.includes("restaurant") || msg.includes("food") || msg.includes("chop bar")) chat.lead.businessType = "Food / Restaurant";
  if (msg.includes("school") || msg.includes("university") || msg.includes("college")) chat.lead.businessType = "School / Education";
  if (msg.includes("shop") || msg.includes("store") || msg.includes("clothing")) chat.lead.businessType = "Shop / Retail";
  if (msg.includes("hotel") || msg.includes("guest house")) chat.lead.businessType = "Hotel / Hospitality";
  if (msg.includes("delivery")) chat.lead.businessType = "Delivery";
  if (msg.includes("bot") || msg.includes("automation") || msg.includes("whatsapp")) chat.lead.requirement = text;
}

// =====================================================
// BUILD CONVERSATION PROMPT
// =====================================================

function buildConversationPrompt(messages) {
  return messages.slice(-12).map((m) => {
    const role = m.role === "user" ? "Customer" : "Assistant";
    return `${role}: ${m.content}`;
  }).join("\n");
}

const SYSTEM_PROMPT = `
You are the official AI assistant for Stony_Tech.

Stony_Tech builds:
- WhatsApp bots and AI assistants
- Business automation systems
- WhatsApp ordering systems
- Customer support automation
- Booking systems and payment integrations
- Business dashboards and custom software

Your job is to speak naturally with customers and understand what they need.

Rules:
- Be friendly and professional.
- Keep replies concise and natural — do not sound robotic.
- Do not invent prices. If pricing is asked, say it depends on project requirements.
- Ask useful questions when necessary.
- If someone wants a WhatsApp bot, ask about their business and what the bot should do.
- Guide interested customers toward getting started with Stony_Tech.
`.trim();

// =====================================================
// GEMINI
// =====================================================

async function askGemini(messages) {
  if (!genAI) throw new Error("Gemini API key is missing");
  console.log("🧠 Asking Gemini...");
  const conversation = buildConversationPrompt(messages);
  const prompt = `${SYSTEM_PROMPT}\n\nConversation:\n${conversation}\n\nReply naturally to the customer.`;
  const result = await genAI.models.generateContent({ model: GEMINI_MODEL, contents: prompt });
  const text = result?.text || result?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  if (!text.trim()) throw new Error("Gemini returned an empty response");
  return text.trim();
}

// =====================================================
// GROQ
// =====================================================

async function askGroq(messages) {
  if (!groq) throw new Error("Groq API key is missing");
  console.log("🔄 Falling back to Groq...");
  const conversation = buildConversationPrompt(messages);
  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: conversation }
    ],
    temperature: 0.7,
    max_tokens: 500
  });
  const text = completion?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned an empty response");
  return text.trim();
}

// =====================================================
// AI WITH FALLBACK
// =====================================================

async function askAI(messages) {
  try {
    return await askGemini(messages);
  } catch (geminiError) {
    console.error("❌ Gemini failed:", geminiError.message);
    try {
      return await askGroq(messages);
    } catch (groqError) {
      console.error("❌ Groq failed:", groqError.message);
      return "Sorry, I'm having a little trouble responding right now. Please try again shortly.";
    }
  }
}

// =====================================================
// SEND META MESSAGE
// =====================================================

async function sendBotMessage(to, text) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) throw new Error("Meta credentials missing");
  const url = `https://graph.facebook.com/v23.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const response = await axios.post(url,
    { messaging_product: "whatsapp", to: normalizePhone(to), type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
  );
  return response.data;
}

// =====================================================
// NOTIFY OWNER
// =====================================================

async function notifyOwner(chat, customerPhone) {
  if (chat.leadNotified) return;
  chat.leadNotified = true;
  const message = `🚨 NEW STONY_TECH LEAD\n\n📱 Customer:\n+${customerPhone}\n\n🏢 Business:\n${chat.lead.businessType || "Not identified"}\n\n💡 Requirement:\n${chat.lead.requirement || "Not identified"}\n\nThe customer appears interested in Stony_Tech services.`;
  try {
    await sendBotMessage(OWNER_NUMBER, message.trim());
    console.log(`📢 Lead notification sent for +${customerPhone}`);
  } catch (error) {
    console.error("❌ Failed to notify owner:", error.response?.data || error.message);
  }
}

// =====================================================
// CANCEL FALLBACK TIMER
// =====================================================

function cancelFallbackTimer(chat) {
  if (chat.fallbackTimer) {
    clearTimeout(chat.fallbackTimer);
    chat.fallbackTimer = null;
    console.log("🛑 Fallback timer cancelled.");
  }
}

// =====================================================
// START FALLBACK TIMER
// =====================================================

function startFallbackTimer(sessionKey, phone, jid) {
  const normalizedPhone = normalizePhone(phone);

  if (isBlockedForSession(sessionKey, normalizedPhone)) {
    console.log(`🚫 Blocked number +${normalizedPhone} — timer NOT started.`);
    return;
  }

  const chat = getPersonalChat(normalizedPhone);

  if (chat.fallbackTimer) {
    clearTimeout(chat.fallbackTimer);
    chat.fallbackTimer = null;
    console.log(`🔄 Timer reset for +${normalizedPhone}`);
  }

  chat.ownerReplied = false;
  chat.lastJid = jid;

  console.log(`⏳ Timer started for +${normalizedPhone}`);

  chat.fallbackTimer = setTimeout(async () => {
    chat.fallbackTimer = null;

    // 🚫 Block check inside timer
    if (isBlockedForSession(sessionKey, normalizedPhone)) {
      console.log(`🚫 +${normalizedPhone} is blocked — AI takeover cancelled.`);
      return;
    }

    if (chat.ownerReplied) {
      console.log(`👤 Owner already replied to +${normalizedPhone}.`);
      return;
    }

    const session = baileysSessions[sessionKey];
    if (!session?.sock) {
      console.log(`❌ No socket for ${sessionKey}`);
      return;
    }

    chat.botActive = true;

    const takeoverMessage = "Hi! 👋 Stony is not currently available, but I'm the assistant and I'm here to help you.\n\nHow can I assist you please?";

    try {
      if (isBlockedForSession(sessionKey, normalizedPhone) || chat.ownerReplied) {
        chat.botActive = false;
        return;
      }

      await session.sock.sendMessage(jid, { text: takeoverMessage });
      saveMessage(chat, "assistant", takeoverMessage);
      console.log(`🤖 AI takeover for +${normalizedPhone}`);

      if (chat.ownerReplied || isBlockedForSession(sessionKey, normalizedPhone)) {
        chat.botActive = false;
        return;
      }

      const aiReply = await askAI(chat.messages);

      if (chat.ownerReplied || isBlockedForSession(sessionKey, normalizedPhone)) {
        chat.botActive = false;
        return;
      }

      await session.sock.sendMessage(jid, { text: aiReply });
      saveMessage(chat, "assistant", aiReply);
      console.log(`🤖 AI response sent to +${normalizedPhone}`);

    } catch (error) {
      console.error(`❌ AI error for +${normalizedPhone}:`, error.message);
    } finally {
      chat.botActive = false;
    }
  }, FALLBACK_DELAY_MS);
}

// =====================================================
// RESOLVE SENDER — FIXED @lid HANDLING
// =====================================================

async function resolveSenderNumber(sock, remoteJid, msg) {
  // 1. Normal JID — easiest case
  if (remoteJid?.endsWith("@s.whatsapp.net")) {
    const phone = normalizePhone(remoteJid);
    return phone;
  }

  // 2. Check our LID→phone map first (built up over time)
  if (remoteJid?.endsWith("@lid")) {
    const cached = phoneFromLid(remoteJid);
    if (cached) {
      console.log(`🗂️  LID resolved from cache: +${cached}`);
      return cached;
    }

    // 3. Try Baileys LID mapping API
    try {
      const lidMapping = sock?.authState?.creds?.lid ||
                         sock?.signalRepository?.lidMapping;

      if (lidMapping && typeof lidMapping.getPNForLID === "function") {
        const pn = await lidMapping.getPNForLID(remoteJid);
        if (pn) {
          const phone = normalizePhone(pn);
          saveLidMapping(remoteJid, phone);
          return phone;
        }
      }
    } catch (err) {
      console.error("❌ LID API failed:", err.message);
    }

    // 4. Try contacts store
    try {
      const contacts = sock?.store?.contacts || {};
      const contact  = contacts[remoteJid];
      if (contact?.id) {
        const phone = normalizePhone(contact.id);
        saveLidMapping(remoteJid, phone);
        return phone;
      }
    } catch (err) {}

    // 5. Try participant from message
    const participant = msg?.participant ||
                        msg?.key?.participant ||
                        msg?.key?.remoteJid;

    if (participant && participant.endsWith("@s.whatsapp.net")) {
      const phone = normalizePhone(participant);
      saveLidMapping(remoteJid, phone);
      return phone;
    }

    // 6. Use the LID number itself as a last resort
    // WhatsApp LIDs often contain the real number encoded
    const lidNumber = remoteJid.replace("@lid", "").replace(/\D/g, "");
    if (lidNumber && lidNumber.length >= 10) {
      console.log(`⚠️  Using raw LID number as fallback: +${lidNumber}`);
      return lidNumber;
    }
  }

  return null;
}

// =====================================================
// START BAILEYS CLIENT
// =====================================================

async function startBaileysClient(sessionKey, phone, authFolder) {
  console.log(`\n🚀 Starting ${sessionKey} WhatsApp...`);

  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    console.log(`📦 Baileys ${version.join(".")} for ${sessionKey}`);
  } catch (err) {
    console.log("⚠️ Could not fetch Baileys version.");
  }

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Stony_Tech", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  baileysSessions[sessionKey].sock = sock;
  sock.ev.on("creds.update", saveCreds);

  // ── Connection updates ──────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      baileysSessions[sessionKey].qr = qr;
      console.log(`📲 QR ready for ${sessionKey} — open /qr`);
    }

    if (connection === "open") {
      baileysSessions[sessionKey].connected = true;
      baileysSessions[sessionKey].qr = null;
      console.log(`✅ ${sessionKey} connected.`);
    }

    if (connection === "close") {
      baileysSessions[sessionKey].connected = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`❌ ${sessionKey} disconnected. Code: ${statusCode}`);
      if (shouldReconnect) {
        console.log(`🔄 Reconnecting ${sessionKey} in 5s...`);
        setTimeout(() => startBaileysClient(sessionKey, phone, authFolder), 5000);
      } else {
        console.log(`🔐 ${sessionKey} logged out. Delete auth folder and re-scan.`);
      }
    }
  });

  // ── Contacts update — build LID→phone map ──────────
  sock.ev.on("contacts.update", (contacts) => {
    for (const contact of contacts) {
      if (contact.id?.endsWith("@lid") && contact.notify) {
        // pushName doesn't give us phone but id might
      }
      if (contact.id?.endsWith("@s.whatsapp.net")) {
        // Save normal contacts for cross-reference
        const phone = normalizePhone(contact.id);
        if (contact.lid) saveLidMapping(contact.lid, phone);
      }
    }
  });

  // ── Contacts upsert — build LID→phone map ──────────
  sock.ev.on("contacts.upsert", (contacts) => {
    for (const contact of contacts) {
      if (contact.id?.endsWith("@s.whatsapp.net") && contact.lid) {
        const phone = normalizePhone(contact.id);
        saveLidMapping(contact.lid, phone);
      }
    }
  });

  // ── Incoming messages ───────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg?.message) continue;

        const remoteJid = msg.key?.remoteJid;
        if (!remoteJid) continue;
        if (remoteJid === "status@broadcast") continue;
        if (remoteJid.endsWith("@g.us")) continue;

        const isPersonal = remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@lid");
        if (!isPersonal) continue;

        console.log(`\n📩 [${sessionKey}] JID: ${remoteJid} | fromMe: ${msg.key?.fromMe}`);

        // Resolve number
        const from = await resolveSenderNumber(sock, remoteJid, msg);

        if (!from) {
          console.log(`⚠️ Could not resolve number for JID: ${remoteJid}`);
          // Still try to cache for future messages
          continue;
        }

        console.log(`From: +${from}`);

        // Cache LID→phone for future messages
        if (remoteJid.endsWith("@lid")) {
          saveLidMapping(remoteJid, from);
        }

        const chat = getPersonalChat(from);
        chat.jids.add(remoteJid);
        chat.lastJid = remoteJid;

        // ── Owner replied ───────────────────────────
        if (msg.key?.fromMe) {
          const text = extractMessageText(msg.message);
          if (text) {
            cancelFallbackTimer(chat);
            chat.ownerReplied = true;
            chat.botActive    = false;
            saveMessage(chat, "assistant", text);
            console.log(`🛑 AI disabled for +${from} — owner replied`);
          }
          continue;
        }

        // 🚫 Block check
        if (isBlockedForSession(sessionKey, from)) {
          console.log(`🚫 BLOCKED: +${from} — no reply, no timer`);
          cancelFallbackTimer(chat);
          chat.botActive = false;
          continue;
        }

        const text = extractMessageText(msg.message);
        if (!text) {
          console.log("⚠️ No readable text.");
          continue;
        }

        console.log(`📨 Customer +${from}: "${text}"`);
        saveMessage(chat, "user", text);
        chat.lastCustomerMessage = Date.now();
        chat.ownerReplied = false;

        updateLeadInformation(chat, text);
        if (detectInterest(text)) await notifyOwner(chat, from);

        // Bot already active → reply immediately
        if (chat.botActive) {
          console.log(`🤖 Bot active — replying immediately to +${from}`);
          const aiReply = await askAI(chat.messages);
          if (isBlockedForSession(sessionKey, from) || chat.ownerReplied) continue;
          await sock.sendMessage(remoteJid, { text: aiReply });
          saveMessage(chat, "assistant", aiReply);
          continue;
        }

        // Start fallback timer
        startFallbackTimer(sessionKey, from, remoteJid);

      } catch (error) {
        console.error("❌ Message handling error:", error.message);
      }
    }
  });
}

// =====================================================
// META WEBHOOK VERIFY
// =====================================================

app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("✅ Meta webhook verified.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// =====================================================
// META WEBHOOK
// =====================================================

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const messages = change.value?.messages || [];
        for (const message of messages) {
          try {
            const from = normalizePhone(message.from);
            if (!from) continue;
            if (message.type !== "text") continue;
            const text = message.text?.body || "";
            if (!text.trim()) continue;

            console.log(`\n📥 META +${from}: "${text}"`);
            const chat = getMetaChat(from);
            chat.lastCustomerMessage = Date.now();
            saveMessage(chat, "user", text);
            updateLeadInformation(chat, text);
            if (detectInterest(text)) await notifyOwner(chat, from);

            chat.botActive = true;
            const aiReply = await askAI(chat.messages);
            await sendBotMessage(from, aiReply);
            saveMessage(chat, "assistant", aiReply);
            console.log(`🤖 Meta reply sent to +${from}`);

          } catch (error) {
            console.error("❌ Meta message error:", error.response?.data || error.message);
          }
        }
      }
    }
  } catch (error) {
    console.error("❌ Meta webhook error:", error.response?.data || error.message);
  }
});

// =====================================================
// QR PAGE
// =====================================================

app.get("/qr", (req, res) => {
  const makeQR = (title, qr, connected) => {
    if (connected) return `<div class="card"><h2>${title}</h2><p class="connected">✅ Connected</p></div>`;
    if (!qr) return `<div class="card"><h2>${title}</h2><p>⏳ Waiting for QR code...</p><meta http-equiv="refresh" content="5"></div>`;
    const qrImage = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr);
    return `<div class="card"><h2>${title}</h2><p>Scan with WhatsApp → Linked Devices → Link a Device</p><img src="${qrImage}" width="300" height="300" alt="QR"/></div>`;
  };
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Stony_Tech QR</title>
    <style>body{margin:0;padding:30px;font-family:Arial;background:#111;color:white;text-align:center}
    .card{background:#1d1d1d;padding:25px;margin:25px auto;border-radius:15px;max-width:380px;box-shadow:0 10px 30px rgba(0,0,0,0.4)}
    img{background:white;padding:10px;border-radius:10px;max-width:90%}.connected{color:#00ff88;font-weight:bold}</style></head>
    <body><h1>Stony_Tech WhatsApp</h1>
    ${makeQR("Main Personal Number", baileysSessions.main.qr, baileysSessions.main.connected)}
    ${makeQR("Second Personal Number", baileysSessions.second.qr, baileysSessions.second.connected)}
    <p style="color:#888;font-size:12px">LID mappings cached: ${lidToPhone.size}</p>
    <script>setTimeout(()=>location.reload(),10000)</script>
    </body></html>`);
});

// =====================================================
// BLOCKED PAGE
// =====================================================

app.get("/blocked", (req, res) => {
  const makeList = (numbers) => numbers.length === 0
    ? `<li style="color:#888;font-style:italic">No blocked numbers</li>`
    : numbers.map(n => `<li><span style="background:#fee2e2;color:#b91c1c;font-size:11px;padding:2px 8px;border-radius:20px;font-weight:700;margin-right:8px">BLOCKED</span>+${n}</li>`).join("");

  res.send(`<!DOCTYPE html><html><head><title>Blocked Numbers</title>
    <style>body{font-family:sans-serif;background:#f4f4f9;padding:30px}
    .card{background:white;border-radius:12px;padding:20px;margin-bottom:20px;max-width:400px;box-shadow:0 2px 8px rgba(0,0,0,0.08)}
    ul{list-style:none;padding:0;margin:0}li{padding:8px 0;border-bottom:1px solid #f0f0f0}li:last-child{border-bottom:none}
    a{color:#2563eb;font-size:13px}</style></head>
    <body><h1>🚫 Blocked Numbers</h1>
    <p style="color:#666;margin-bottom:20px">These numbers get no auto-reply — ever.</p>
    <div class="card"><h2>Main (+${baileysSessions.main.phone})</h2><ul>${makeList(BLOCKED_NUMBERS.main)}</ul></div>
    <div class="card"><h2>Second (+${baileysSessions.second.phone})</h2><ul>${makeList(BLOCKED_NUMBERS.second)}</ul></div>
    <a href="/">← Back</a></body></html>`);
});

// =====================================================
// HEALTH
// =====================================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    geminiModel: GEMINI_MODEL,
    groqModel: GROQ_MODEL,
    main:   { phone: baileysSessions.main.phone,   connected: baileysSessions.main.connected },
    second: { phone: baileysSessions.second.phone, connected: baileysSessions.second.connected },
    lidMappings: lidToPhone.size,
    personalChats: personalChats.size,
    metaChats: metaChats.size,
    geminiConfigured: Boolean(GEMINI_API_KEY),
    groqConfigured:   Boolean(GROQ_API_KEY)
  });
});

// =====================================================
// HOME
// =====================================================

app.get("/", (req, res) => {
  res.send(`<html><body style="font-family:Arial;background:#111;color:white;text-align:center;padding:50px">
    <h1>🤖 Stony_Tech AI Assistant</h1>
    <p>WhatsApp automation system is running.</p>
    <p><a href="/qr"      style="color:#00ff88;font-size:20px">📱 Open WhatsApp QR</a></p>
    <p><a href="/blocked" style="color:#ff6b6b;font-size:20px">🚫 Blocked Numbers</a></p>
    <p><a href="/health"  style="color:#00aaff;font-size:20px">❤️  System Health</a></p>
  </body></html>`);
});

app.use((req, res) => res.status(404).json({ error: "Route not found" }));

// =====================================================
// START
// =====================================================

app.listen(PORT, () => {
  console.log(`🚀 Stony_Tech running on port ${PORT}`);
  console.log(`📱 Open /qr to scan QR codes`);
  startBaileysClient("main",   baileysSessions.main.phone,   AUTH_FOLDER_MAIN);
  startBaileysClient("second", baileysSessions.second.phone, AUTH_FOLDER_SEC);
});
