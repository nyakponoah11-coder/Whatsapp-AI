require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");
const { Groq } = require("groq-sdk");
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const {
  GEMINI_API_KEY,
  GROQ_API_KEY,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
} = process.env;

if (!GEMINI_API_KEY)             console.warn("⚠️  Missing GEMINI_API_KEY");
if (!GROQ_API_KEY)              console.warn("⚠️  Missing GROQ_API_KEY");
if (!WHATSAPP_ACCESS_TOKEN)    console.warn("⚠️  Missing WHATSAPP_ACCESS_TOKEN");
if (!WHATSAPP_PHONE_NUMBER_ID) console.warn("⚠️  Missing WHATSAPP_PHONE_NUMBER_ID");
if (!WHATSAPP_VERIFY_TOKEN)    console.warn("⚠️  Missing WHATSAPP_VERIFY_TOKEN");

const ai   = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const groq = new Groq({ apiKey: GROQ_API_KEY });

// ============================================================
// CONFIG
// ============================================================

const OWNER_NUMBER      = "233547100951";
const FALLBACK_DELAY_MS = 1 * 60 * 1000; // 1 minute
const AUTH_FOLDER_MAIN  = "./baileys_auth";
const AUTH_FOLDER_SEC   = "./baileys_auth_second";

// ============================================================
// BLOCKED NUMBERS (Applies ONLY to Baileys personal numbers)
// ============================================================

const BLOCKED_NUMBERS = {
  main:   ["233599779237", "233550901484", "233599599254", "233243682726"],
  second: ["233535840183", "233267103209", "233547100951"]
};

const ALL_BLOCKED_NUMBERS = [...BLOCKED_NUMBERS.main, ...BLOCKED_NUMBERS.second];

// ============================================================
// SMART HELPER: CHECK IF NUMBER IS BLOCKED (Baileys only)
// ============================================================

function isBlocked(from, ignoredList = ALL_BLOCKED_NUMBERS) {
  if (!from) return false;
  const cleanFrom = String(from).replace(/\D/g, "");
  
  const matched = ignoredList.some(num => {
    const cleanNum = String(num).replace(/\D/g, "");
    return cleanFrom === cleanNum || cleanFrom.endsWith(cleanNum) || cleanNum.endsWith(cleanFrom);
  });

  return matched;
}

// ============================================================
// BUSINESS RULES
// ============================================================

const BUSINESS_RULES = `
You are the personal business assistant for Stony_Tech.

YOUR MAIN PURPOSE:
You represent Stony_Tech on WhatsApp.

Stony_Tech builds custom WhatsApp bots, AI assistants and business
automation systems for restaurants, shops, schools, businesses,
service providers and other vendors.

SERVICES STONY_TECH CAN BUILD:

1. WhatsApp AI chatbots
2. WhatsApp ordering bots
3. Restaurant ordering systems
4. Customer service bots
5. Business enquiry bots
6. Booking and reservation bots
7. Automated customer support
8. Payment-integrated bots
9. Order management systems
10. AI-powered business assistants
11. Custom business automation
12. Admin dashboards connected to business bots

YOUR JOB:

- Welcome potential customers.
- Find out what type of business they operate.
- Understand what they want to automate.
- Understand the problem they currently have.
- Explain how Stony_Tech can help.
- Collect useful information naturally.
- Identify serious potential clients.
- Tell serious clients that a Stony_Tech team member will personally follow up.

IMPORTANT BUSINESS RULES:

- Do NOT invent prices.
- Do NOT give a fixed price unless Stony_Tech has provided one.
- If someone asks for the price, explain that pricing depends on the
  features and complexity of the system.
- Do not promise a delivery date.
- Do not claim that a project has already been approved.
- Do not pretend to be a human.
- You are Stony's personal assistant.
- Be friendly, professional and natural.
- Keep WhatsApp replies reasonably short.
- Do not overwhelm customers with too many questions at once.

WHEN A CUSTOMER IS INTERESTED:

Collect enough information for Stony_Tech to follow up.

Try to understand:

1. Customer name
2. Business name
3. Business type
4. What they want the bot to do
5. Their current problem
6. Features they need
7. Preferred timeline
8. Budget, if appropriate

When the customer is clearly interested, you can say:

"Great 👍 I'll pass your details to the Stony_Tech team and they'll personally
follow up with you."

Do not say the team has received the information unless the system has
actually notified them.
`.trim();

// ============================================================
// BOT NUMBER CONVERSATIONS (Meta API)
// ============================================================

const botConversations = new Map();

function getBotConversation(phone) {
  if (!botConversations.has(phone)) {
    botConversations.set(phone, {
      messages: [],
      notifiedOwner: false,
      lead: { name: null, business: null, businessType: null, requirement: null }
    });
  }
  return botConversations.get(phone);
}

// ============================================================
// PERSONAL & SECONDARY NUMBER CONVERSATIONS (Baileys)
// ============================================================

const personalChats = new Map();

function getPersonalChat(phone) {
  if (!personalChats.has(phone)) {
    personalChats.set(phone, {
      messages: [],
      ownerReplied: false,
      botActive: false,
      fallbackTimer: null,
      lastCustomerMessage: null,
      lead: { name: null, business: null, businessType: null, requirement: null, notifiedOwner: false }
    });
  }
  return personalChats.get(phone);
}

// ============================================================
// INTEREST DETECTION
// ============================================================

function detectInterest(text) {
  const msg = text.toLowerCase().trim();
  const patterns = [
    "i'm interested","im interested","i am interested",
    "i want one","i need one","i want a bot","i need a bot",
    "i want you to build","i need you to build",
    "build one for me","build it for me",
    "can you build one","can you build this",
    "can you make one","make one for me",
    "i want this for my business","i need this for my business",
    "i want to get started","how can i get started",
    "let's do it","lets do it",
    "i want to work with you",
    "i want to talk to him",
    "i need your service","i want your service",
    "how much will it cost","what will it cost",
    "how much is it","i want to order one"
  ];
  return patterns.some(p => msg.includes(p));
}

// ============================================================
// LEAD INFORMATION
// ============================================================

function updateLeadInformation(conversation, text) {
  const lower = text.toLowerCase();
  const businessTypes = [
    "restaurant","food","shop","store","school","salon","barber",
    "hotel","pharmacy","hospital","church","company","business",
    "clothing","fashion","delivery","logistics"
  ];
  for (const type of businessTypes) {
    if (lower.includes(type)) { conversation.lead.businessType = type; break; }
  }
  const requirementPatterns = [
    "ordering bot","order bot","whatsapp bot","ai bot",
    "customer service","booking bot","booking system",
    "ordering system","payment bot","delivery bot","restaurant bot","chatbot"
  ];
  for (const req of requirementPatterns) {
    if (lower.includes(req)) { conversation.lead.requirement = text; break; }
  }
}

// ============================================================
// ROBUST MESSAGE TEXT EXTRACTOR
// ============================================================

function extractMessageText(msgObj) {
  if (!msgObj) return "";
  if (msgObj.conversation) return msgObj.conversation;
  if (msgObj.extendedTextMessage?.text) return msgObj.extendedTextMessage.text;
  if (msgObj.imageMessage?.caption) return msgObj.imageMessage.caption;
  if (msgObj.videoMessage?.caption) return msgObj.videoMessage.caption;

  const innerKeys = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage'];
  for (const key of innerKeys) {
    if (msgObj[key]?.message) {
      const extracted = extractMessageText(msgObj[key].message);
      if (extracted) return extracted;
    }
  }
  return "";
}

// ============================================================
// AI ENGINE (Gemini with Groq Cloud Fallback)
// ============================================================

async function askAI(messages) {
  const history = messages.slice(-12).map(m => `${m.role}: ${m.text}`).join("\n");
  const prompt = `
BUSINESS RULES:
${BUSINESS_RULES}

CONVERSATION:
${history}

Respond to the customer based on the business rules.
- Be natural and friendly.
- Keep the response reasonably short.
- Ask useful questions when more information is needed.
- Do not ask too many questions at once.
- Never invent pricing.
`.trim();

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await ai.models.generateContent({ model, contents: prompt });
      const reply = result.text?.trim();
      if (reply) return reply;
      throw new Error("Gemini returned empty response.");
    } catch (error) {
      const status = error?.status || error?.response?.status;
      if (status === 503 || status === 429) {
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }
      } else {
        break;
      }
    }
  }

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: BUSINESS_RULES },
        { role: "user", content: prompt }
      ],
      model: "llama3-70b-8192",
      temperature: 0.7,
    });
    const groqReply = chatCompletion.choices[0]?.message?.content?.trim();
    if (groqReply) return groqReply;
    throw new Error("Groq returned empty response.");
  } catch (groqError) {
    throw new Error("Both AI engines failed.");
  }
}

// ============================================================
// NOTIFY OWNER via Meta API (bot number)
// ============================================================

async function notifyOwner(from, userText, conversation, sourceLabel = "Meta Bot") {
  if (conversation.notifiedOwner) return;
  const lead = conversation.lead;
  const msg = `🚨 NEW POTENTIAL CLIENT (${sourceLabel})\n\n📱 Customer: +${from}\n🏢 Business: ${lead.business || "Not provided"}\n💼 Business Type: ${lead.businessType || "Not provided"}\n🤖 Bot Needed: ${lead.requirement || "Not fully identified"}\n💬 Message: "${userText}"\n🔥 Interest: HIGH\n\n👉 Please follow up with this customer.`;
  try {
    await sendBotMessage(OWNER_NUMBER, msg);
    conversation.notifiedOwner = true;
  } catch (err) {}
}

// ============================================================
// SEND MESSAGE via Meta API (bot number)
// ============================================================

async function sendBotMessage(to, body) {
  const url = `https://graph.facebook.com/v23.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await axios.post(url,
    { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } },
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
  );
  return res.data;
}

// ============================================================
// MULTI-BAILEYS SETUP
// ============================================================

const baileysSessions = {
  main:   { phone: "233547100951", qr: null, connected: false, sock: null },
  second: { phone: "233533161186", qr: null, connected: false, sock: null }
};

async function startBaileysClient(sessionKey, phoneNumber, authFolder) {
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: require("pino")({ level: "silent" }),
    browser: [`Stony_Tech Bot (${phoneNumber})`, "Chrome", "1.0.0"],
    syncFullHistory: true,
    markOnlineOnConnect: true,
    getMessage: async (key) => ({ conversation: "Hello" })
  });

  baileysSessions[sessionKey].sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) baileysSessions[sessionKey].qr = qr;
    if (connection === "open") {
      baileysSessions[sessionKey].connected = true;
      baileysSessions[sessionKey].qr = null;
      console.log(`✅ Baileys [${sessionKey.toUpperCase()} - +${phoneNumber}] connected successfully!`);
    }

    if (connection === "close") {
      baileysSessions[sessionKey].connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        setTimeout(() => startBaileysClient(sessionKey, phoneNumber, authFolder), 5000);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        const jid = msg.key?.remoteJid;
        if (!jid || jid === "status@broadcast" || jid.includes("@g.us")) continue;
        if (!jid.endsWith("@s.whatsapp.net")) continue;

        const fromMe = msg.key.fromMe;
        const from   = jid.replace("@s.whatsapp.net", "");
        const label  = sessionKey === "main" ? "Main Personal Number" : "Secondary Personal Number";
        const text   = extractMessageText(msg.message);

        if (!text.trim()) continue;

        // ============================================================
        // CRITICAL CHECK: BLOCKED NUMBERS MUST SHOW IN LOGS & BE IGNORED
        // ============================================================
        if (isBlocked(from)) {
          console.log(`🚫 [BLOCKED NUMBER] Message from +${from} on ${label} -> Ignored (Blocked Number). Content: "${text.trim()}"`);
          continue; // Skips timer, skips bot reply, but strictly logs it!
        }

        if (fromMe) {
          const chat = getPersonalChat(from);
          chat.ownerReplied = true;
          chat.botActive    = false;
          if (chat.fallbackTimer) {
            clearTimeout(chat.fallbackTimer);
            chat.fallbackTimer = null;
          }
          chat.messages.push({ role: "assistant", text: text.trim() });
          console.log(`👤 [OWNER REPLY] Message from this number (+${from}) -> Owner replied manually, timer cleared.`);
          continue;
        }

        // UNBLOCKED / UNKNOWN NUMBER PROCESSING
        console.log(`📥 [UNBLOCKED / UNKNOWN NUMBER] Message from +${from} on ${label}: "${text.trim()}"`);

        const chat = getPersonalChat(from);
        chat.messages.push({ role: "customer", text: text.trim() });
        chat.lastCustomerMessage = text.trim();

        updateLeadInformation(chat, text.trim());
        if (detectInterest(text.trim())) {
          await notifyOwner(from, text.trim(), chat, label);
        }

        if (chat.botActive) {
          let reply;
          try {
            reply = await askAI(chat.messages);
          } catch {
            reply = "Sorry, I'm having a little trouble right now. Please try again shortly. 🙏";
          }
          chat.messages.push({ role: "assistant", text: reply });
          if (chat.messages.length > 20) chat.messages = chat.messages.slice(-20);
          await sock.sendMessage(jid, { text: reply });
          console.log(`📤 [BOT REPLY] Replied to unblocked number +${from} on ${label} with: "${reply}"`);
          continue;
        }

        console.log(`⏱️ [FALLBACK TIMER] Starting 1-minute timer for unblocked number +${from} on ${label}...`);
        startFallbackTimer(from, jid, chat, sock, label);

      } catch (err) {
        console.error(`❌ Message handler error on Baileys [${sessionKey}]:`, err?.message);
      }
    }
  });
}

// ============================================================
// FALLBACK TIMER
// ============================================================

function startFallbackTimer(from, jid, chat, activeSock, label) {
  if (chat.fallbackTimer || chat.botActive) return;

  chat.ownerReplied = false;

  chat.fallbackTimer = setTimeout(async () => {
    chat.fallbackTimer = null;

    if (isBlocked(from)) return;

    if (!chat.ownerReplied && activeSock) {
      console.log(`⏰ [TIMER EXPIRED] Owner didn't reply within 1 minute. Bot taking over chat with unblocked number +${from} on ${label}`);
      chat.botActive = true;

      const unavailableMsg = "Hi! 👋 Stony is not currently available, but I'm the assistant and I'm here to help you.\n\nHow can I assist you please?";

      try {
        await activeSock.sendMessage(jid, { text: unavailableMsg });
        chat.messages.push({ role: "assistant", text: unavailableMsg });
        console.log(`📤 [BOT TAKEOVER REPLY] Sent initial automated greeting to +${from}`);

        if (chat.lastCustomerMessage) {
          let aiReply;
          try {
            aiReply = await askAI(chat.messages);
          } catch {
            aiReply = "I'm here to help! Could you tell me about your business and what you need? 😊";
          }
          chat.messages.push({ role: "assistant", text: aiReply });
          await activeSock.sendMessage(jid, { text: aiReply });
          console.log(`📤 [BOT TAKEOVER REPLY] Sent AI follow-up response to +${from} with: "${aiReply}"`);
        }
      } catch (err) {}
    }
  }, FALLBACK_DELAY_MS);
}

// ============================================================
// META WEBHOOK VERIFICATION
// ============================================================

app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ============================================================
// BOT NUMBER WEBHOOK (Meta API)
// ============================================================

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const value   = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message || message.type !== "text") return;

    const from     = message.from;
    const userText = message.text?.body?.trim();
    if (!from || !userText) return;

    console.log(`📥 [META BOT] Message from unblocked number +${from}: "${userText}"`);

    const conversation = getBotConversation(from);
    conversation.messages.push({ role: "customer", text: userText });
    updateLeadInformation(conversation, userText);

    if (detectInterest(userText)) {
      await notifyOwner(from, userText, conversation, "Meta Bot");
    }

    let reply;
    try {
      reply = await askAI(conversation.messages);
    } catch (err) {
      reply = "Sorry, I'm having a little trouble responding right now. Please try again in a moment. 🙏";
    }

    if (!reply) reply = "Sorry, I couldn't generate a response right now. Please try again.";

    conversation.messages.push({ role: "assistant", text: reply });
    if (conversation.messages.length > 20) conversation.messages = conversation.messages.slice(-20);

    await sendBotMessage(from, reply);
    console.log(`📤 [META BOT] Replied to +${from} with: "${reply}"`);

  } catch (err) {}
});

// ============================================================
// HTML PAGES (/blocked, /qr, /, /health)
// ============================================================

app.get("/blocked", (req, res) => {
  res.send(`<h1>Blocked Numbers Dashboard</h1><p>Main: ${BLOCKED_NUMBERS.main.join(", ")}</p><p>Second: ${BLOCKED_NUMBERS.second.join(", ")}</p><a href="/">Back</a>`);
});

app.get("/qr", (req, res) => {
  let html = `
    <html>
      <head>
        <title>Scan WhatsApp QRs</title>
        <style>
          body { font-family: sans-serif; text-align: center; padding: 20px; background: #f4f4f9; }
          .card { background: white; padding: 20px; border-radius: 10px;
                  box-shadow: 0 4px 6px rgba(0,0,0,0.1); display: inline-block;
                  margin: 15px; width: 320px; vertical-align: top; text-align: center; }
          img { border-radius: 10px; border: 1px solid #ddd; padding: 10px; background: white; width: 250px; height: 250px; }
          h2 { color: #333; margin-bottom: 5px; }
          p.status { font-weight: bold; margin-top: 15px; }
          a.back { display: block; margin-top: 20px; color: #007bff; text-decoration: none; }
        </style>
      </head>
      <body>
        <h1>📱 Connect Your Numbers</h1>
        <p>Open WhatsApp → Linked Devices → Link a Device → Scan</p>
        <div style="margin-top: 20px;">
  `;

  // Main Number Card
  html += `<div class="card"><h2>Main Number</h2><p>+${baileysSessions.main.phone}</p>`;
  if (baileysSessions.main.connected) {
    html += `<p class="status" style="color:green;">✅ Connected!</p>`;
  } else if (baileysSessions.main.qr) {
    html += `<img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(baileysSessions.main.qr)}" />`;
  } else {
    html += `<p class="status" style="color:#d97706;">⏳ Generating QR...</p>`;
  }
  html += `</div>`;

  // Second Number Card
  html += `<div class="card"><h2>Second Number</h2><p>+${baileysSessions.second.phone}</p>`;
  if (baileysSessions.second.connected) {
    html += `<p class="status" style="color:green;">✅ Connected!</p>`;
  } else if (baileysSessions.second.qr) {
    html += `<img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(baileysSessions.second.qr)}" />`;
  } else {
    html += `<p class="status" style="color:#d97706;">⏳ Generating QR...</p>`;
  }
  html += `</div>`;

  html += `
        </div>
        <a class="back" href="/">← Back to Dashboard</a>
        <script>setTimeout(() => { location.reload(); }, 60000);</script>
      </body>
    </html>
  `;
  res.send(html);
});

app.get("/", (req, res) => {
  res.status(200).send(`
    <html>
      <body style="font-family:sans-serif;padding:40px;background:#f4f4f9;">
        <h2>🚀 Stony_Tech AI Bot</h2>
        <p>Main Number (+${baileysSessions.main.phone}): ${baileysSessions.main.connected ? "✅ Connected" : "❌ Disconnected"}</p>
        <p>Second Number (+${baileysSessions.second.phone}): ${baileysSessions.second.connected ? "✅ Connected" : "❌ Disconnected"}</p>
        <br>
        <p><a href="/qr">📱 Scan QR Codes</a></p>
        <p><a href="/blocked">🚫 View Blocked Numbers</a></p>
      </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// ============================================================
// START SERVER & CLIENTS
// ============================================================

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  startBaileysClient("main", baileysSessions.main.phone, AUTH_FOLDER_MAIN);
  startBaileysClient("second", baileysSessions.second.phone, AUTH_FOLDER_SEC);
});
