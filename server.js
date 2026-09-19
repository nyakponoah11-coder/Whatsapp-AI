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
const fs = require("fs");

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
const FALLBACK_DELAY_MS = 1 * 60 * 1000; // 1 minute timer
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
// CHECK IF NUMBER IS BLOCKED
// ============================================================

function isBlocked(from, ignoredList = ALL_BLOCKED_NUMBERS) {
  if (!from) return false;
  const cleanFrom = String(from).replace(/\D/g, "");
  
  return ignoredList.some(num => {
    const cleanNum = String(num).replace(/\D/g, "");
    return cleanFrom === cleanNum || cleanFrom.endsWith(cleanNum) || cleanNum.endsWith(cleanFrom);
  });
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
- Explain how Stony_Tech can help.
- Be friendly, professional and natural.
- Keep WhatsApp replies reasonably short.
- Do not invent prices.
`.trim();

// ============================================================
// CONVERSATION STORES
// ============================================================

const botConversations = new Map();
const personalChats = new Map();

function getBotConversation(phone) {
  if (!botConversations.has(phone)) {
    botConversations.set(phone, { messages: [], notifiedOwner: false, lead: { name: null, business: null, businessType: null, requirement: null } });
  }
  return botConversations.get(phone);
}

function getPersonalChat(phone) {
  if (!personalChats.has(phone)) {
    personalChats.set(phone, {
      messages: [],
      ownerReplied: false,
      botActive: false,
      fallbackTimer: null,
      lastCustomerMessage: null,
      lead: { name: null, business: null, businessType: null, requirement: null }
    });
  }
  return personalChats.get(phone);
}

// ============================================================
// INTEREST & LEAD DETECTION
// ============================================================

function detectInterest(text) {
  const msg = text.toLowerCase().trim();
  const patterns = [
    "i'm interested","im interested","i am interested",
    "i want one","i need one","i want a bot","i need a bot",
    "i want you to build","i need you to build",
    "build one for me","build it for me","can you build one",
    "i want to get started","how can i get started",
    "let's do it","lets do it","i need your service","how much is it"
  ];
  return patterns.some(p => msg.includes(p));
}

function updateLeadInformation(conversation, text) {
  const lower = text.toLowerCase();
  const businessTypes = ["restaurant","food","shop","store","school","salon","barber","hotel","pharmacy","company","business"];
  for (const type of businessTypes) {
    if (lower.includes(type)) { conversation.lead.businessType = type; break; }
  }
}

// ============================================================
// TEXT EXTRACTOR
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
// AI ENGINE
// ============================================================

async function askAI(messages) {
  const history = messages.slice(-12).map(m => `${m.role}: ${m.text}`).join("\n");
  const prompt = `BUSINESS RULES:\n${BUSINESS_RULES}\n\nCONVERSATION:\n${history}\n\nRespond to the customer naturally and concisely.`;

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  try {
    const result = await ai.models.generateContent({ model, contents: prompt });
    const reply = result.text?.trim();
    if (reply) return reply;
  } catch (err) {}

  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: "system", content: BUSINESS_RULES }, { role: "user", content: prompt }],
      model: "llama3-70b-8192",
      temperature: 0.7,
    });
    return chatCompletion.choices[0]?.message?.content?.trim() || "Hello! How can I help you with your business automation today?";
  } catch (err) {
    return "Hi! Thanks for reaching out. How can I assist you?";
  }
}

// ============================================================
// NOTIFY OWNER
// ============================================================

async function notifyOwner(from, userText, conversation, sourceLabel) {
  if (conversation.notifiedOwner) return;
  const lead = conversation.lead;
  const msg = `🚨 NEW POTENTIAL CLIENT (${sourceLabel})\n\n📱 Customer: +${from}\n💼 Business Type: ${lead.businessType || "Not provided"}\n💬 Message: "${userText}"\n🔥 Interest: HIGH`;
  try {
    await sendBotMessage(OWNER_NUMBER, msg);
    conversation.notifiedOwner = true;
  } catch (err) {}
}

async function sendBotMessage(to, body) {
  const url = `https://graph.facebook.com/v23.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await axios.post(url,
    { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } },
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
  );
  return res.data;
}

// ============================================================
// FALLBACK TIMER (1 Minute Delay)
// ============================================================

function startFallbackTimer(from, jid, chat, activeSock, label) {
  if (chat.fallbackTimer || chat.botActive) return;

  chat.ownerReplied = false;

  chat.fallbackTimer = setTimeout(async () => {
    chat.fallbackTimer = null;

    if (isBlocked(from)) return;

    if (!chat.ownerReplied && activeSock) {
      console.log(`Timer expired after 1 minute. Owner didn't reply. Baileys bot taking over chat with unblocked number +${from} on ${label}`);
      chat.botActive = true;

      const unavailableMsg = "Hi! 👋 Stony is not currently available, but I'm the assistant and I'm here to help you.\n\nHow can I assist you please?";

      try {
        await activeSock.sendMessage(jid, { text: unavailableMsg });
        chat.messages.push({ role: "assistant", text: unavailableMsg });
        console.log(`Baileys bot replied to +${from} with: "${unavailableMsg}"`);

        if (chat.lastCustomerMessage) {
          let aiReply = await askAI(chat.messages);
          chat.messages.push({ role: "assistant", text: aiReply });
          if (chat.messages.length > 20) chat.messages = chat.messages.slice(-20);
          await activeSock.sendMessage(jid, { text: aiReply });
          console.log(`Baileys bot replied to +${from} with: "${aiReply}"`);
        }
      } catch (err) {}
    }
  }, FALLBACK_DELAY_MS);
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
    getMessage: async () => ({ conversation: "Hello" })
  });

  baileysSessions[sessionKey].sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update;
    if (qr) baileysSessions[sessionKey].qr = qr;
    if (connection === "open") {
      baileysSessions[sessionKey].connected = true;
      baileysSessions[sessionKey].qr = null;
      console.log(`✅ Baileys [${sessionKey.toUpperCase()} - +${phoneNumber}] connected successfully!`);
    }
    if (connection === "close") {
      baileysSessions[sessionKey].connected = false;
      setTimeout(() => startBaileysClient(sessionKey, phoneNumber, authFolder), 5000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      try {
        const jid = msg.key?.remoteJid;
        if (!jid || jid === "status@broadcast" || jid.includes("@g.us") || !jid.endsWith("@s.whatsapp.net")) continue;

        const fromMe = msg.key.fromMe;
        const from   = jid.replace("@s.whatsapp.net", "");
        const label  = sessionKey === "main" ? "Main personal number" : "Secondary personal number";
        
        let text = "";
        try {
          text = extractMessageText(msg.message);
        } catch (e) {
          continue;
        }

        if (!text || !text.trim()) continue;

        // ============================================================
        // LOGGING & HANDLING FOR BLOCKED NUMBERS
        // ============================================================
        if (isBlocked(from)) {
          console.log(`Incoming message from this number: +${from}`);
          console.log(`Blocked number: +${from} on ${label} -> Ignored. No reply given.`);
          continue;
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
          console.log(`Owner reply from this number (+${from}) -> Owner replied manually, timer cleared.`);
          continue;
        }

        // ============================================================
        // LOGGING & HANDLING FOR UNBLOCKED NUMBERS (Timer Active)
        // ============================================================
        console.log(`Incoming message from this number: +${from} on ${label}: "${text.trim()}"`);

        const chat = getPersonalChat(from);
        chat.messages.push({ role: "customer", text: text.trim() });
        chat.lastCustomerMessage = text.trim();

        updateLeadInformation(chat, text.trim());
        if (detectInterest(text.trim())) {
          await notifyOwner(from, text.trim(), chat, label);
        }

        if (chat.botActive) {
          let reply = await askAI(chat.messages);
          chat.messages.push({ role: "assistant", text: reply });
          if (chat.messages.length > 20) chat.messages = chat.messages.slice(-20);
          await sock.sendMessage(jid, { text: reply });
          console.log(`Baileys bot replied to unblocked number +${from} on ${label} with: "${reply}"`);
          continue;
        }

        console.log(`Starting 1-minute fallback timer for unblocked number +${from} on ${label}...`);
        startFallbackTimer(from, jid, chat, sock, label);

      } catch (err) {
        if (err?.message?.includes("Bad MAC") || err?.message?.includes("decrypt")) continue;
        console.error(`❌ Message handler error:`, err?.message);
      }
    }
  });
}

// ============================================================
// META WEBHOOK (Bot Number)
// ============================================================

app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const value   = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message || message.type !== "text") return;

    const from     = message.from;
    const userText = message.text?.body?.trim();
    if (!from || !userText) return;

    console.log(`Incoming message from this number: +${from} (Meta Bot)`);

    const conversation = getBotConversation(from);
    conversation.messages.push({ role: "customer", text: userText });
    updateLeadInformation(conversation, userText);

    if (detectInterest(userText)) {
      await notifyOwner(from, userText, conversation, "Meta Bot");
    }

    let reply = await askAI(conversation.messages);
    conversation.messages.push({ role: "assistant", text: reply });
    if (conversation.messages.length > 20) conversation.messages = conversation.messages.slice(-20);

    await sendBotMessage(from, reply);
    console.log(`Meta bot replied to +${from} with: "${reply}"`);
  } catch (err) {}
});

// ============================================================
// DASHBOARD & HEALTH ROUTES
// ============================================================

app.get("/blocked", (req, res) => {
  res.send(`<h1>Blocked Numbers Dashboard</h1><p>Main: ${BLOCKED_NUMBERS.main.join(", ")}</p><p>Second: ${BLOCKED_NUMBERS.second.join(", ")}</p><a href="/">Back</a>`);
});

app.get("/qr", (req, res) => {
  let html = `<html><body style="font-family:sans-serif;text-align:center;padding:20px;"><h1>📱 Connect Your Numbers</h1>`;
  for (const [key, session] of Object.entries(baileysSessions)) {
    html += `<div style="display:inline-block;margin:10px;padding:20px;border:1px solid #ddd;border-radius:10px;"><h2>${key.toUpperCase()} (+${session.phone})</h2>`;
    if (session.connected) html += `<p style="color:green;">✅ Connected!</p>`;
    else if (session.qr) html += `<img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(session.qr)}" />`;
    else html += `<p style="color:#d97706;">⏳ Generating QR...</p>`;
    html += `</div>`;
  }
  html += `<br><a href="/">← Back</a><script>setTimeout(() => location.reload(), 30000);</script></body></html>`;
  res.send(html);
});

app.get("/", (req, res) => {
  res.status(200).send(`<html><body style="font-family:sans-serif;padding:40px;"><h2>🚀 Stony_Tech AI Bot</h2><p><a href="/qr">📱 Scan QR Codes</a> | <a href="/blocked">🚫 View Blocked Numbers</a></p></body></html>`);
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  startBaileysClient("main", baileysSessions.main.phone, AUTH_FOLDER_MAIN);
  startBaileysClient("second", baileysSessions.second.phone, AUTH_FOLDER_SEC);
});
