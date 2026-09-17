require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const {
  GEMINI_API_KEY,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
} = process.env;

if (!GEMINI_API_KEY)          console.warn("⚠️  Missing GEMINI_API_KEY");
if (!WHATSAPP_ACCESS_TOKEN)    console.warn("⚠️  Missing WHATSAPP_ACCESS_TOKEN");
if (!WHATSAPP_PHONE_NUMBER_ID) console.warn("⚠️  Missing WHATSAPP_PHONE_NUMBER_ID");
if (!WHATSAPP_VERIFY_TOKEN)    console.warn("⚠️  Missing WHATSAPP_VERIFY_TOKEN");

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// ============================================================
// CONFIG
// ============================================================

const OWNER_NUMBER      = "233547100951";
const FALLBACK_DELAY_MS = 7 * 60 * 1000; // 1 minute for testing
const AUTH_FOLDER       = "./baileys_auth";

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
// PERSONAL NUMBER CONVERSATIONS (Baileys)
// ============================================================

const personalChats = new Map();

function getPersonalChat(phone) {
  if (!personalChats.has(phone)) {
    personalChats.set(phone, {
      messages: [],
      ownerReplied: false,
      botActive: false,
      fallbackTimer: null,
      lastCustomerMessage: null
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
// GEMINI
// ============================================================

async function askGemini(messages) {
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
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await ai.models.generateContent({ model, contents: prompt });
      const reply = result.text?.trim();
      if (reply) return reply;
      throw new Error("Gemini returned empty response.");
    } catch (error) {
      lastError = error;
      const status = error?.status || error?.response?.status;
      console.error(`Gemini attempt ${attempt} failed:`, error?.message);
      if (status === 503 || status === 429) {
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }
      break;
    }
  }
  throw lastError || new Error("Gemini failed.");
}

// ============================================================
// NOTIFY OWNER via bot number
// ============================================================

async function notifyOwner(from, userText, conversation) {
  if (conversation.notifiedOwner) return;
  const lead = conversation.lead;
  const msg = `🚨 NEW POTENTIAL CLIENT\n\n📱 Customer: +${from}\n🏢 Business: ${lead.business || "Not provided"}\n💼 Business Type: ${lead.businessType || "Not provided"}\n🤖 Bot Needed: ${lead.requirement || "Not fully identified"}\n💬 Message: "${userText}"\n🔥 Interest: HIGH\n\n👉 Please follow up with this customer.`;
  try {
    await sendBotMessage(OWNER_NUMBER, msg);
    conversation.notifiedOwner = true;
  } catch (err) {
    console.error("Failed to notify owner:", err?.message);
  }
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
// BAILEYS SOCKET (personal number)
// ============================================================

let sock = null;
let qrString = null;
let personalConnected = false;

async function startPersonalNumber() {
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`\n🔧 Baileys version: ${version.join(".")}`);

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: require("pino")({ level: "silent" }),
    browser: ["Stony_Tech Bot", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrString = qr;
      console.log("\n📱 SCAN THIS QR CODE WITH YOUR PERSONAL NUMBER (0547100951):");
      console.log("Open WhatsApp → Linked Devices → Link a Device → Scan\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      personalConnected = true;
      qrString = null;
      console.log("✅ Personal number connected via Baileys!");
    }

    if (connection === "close") {
      personalConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️  Personal number disconnected. Status: ${statusCode}. Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        console.log("🔄 Reconnecting in 5 seconds...");
        setTimeout(startPersonalNumber, 5000);
      } else {
        console.log("❌ Logged out. Delete baileys_auth folder and restart to re-scan QR.");
      }
    }
  });

  // ── Incoming messages on personal number ──────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    console.log("🔍 RAW EVENT FIRED:", JSON.stringify(messages[0]?.key));

    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.remoteJid === "status@broadcast") continue;

        const jid = msg.key.remoteJid;
        // Accept both standard JIDs and multi-device LIDs
        if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid")) continue;

        const fromMe = msg.key.fromMe;
        const from = jid.replace("@s.whatsapp.net", "").replace("@lid", "");
        
        const text = msg.message?.conversation ||
                     msg.message?.extendedTextMessage?.text ||
                     msg.message?.imageMessage?.caption ||
                     "";

        if (!text.trim()) continue;

        // ── Noah replied manually ─────────────────────────
        if (fromMe) {
          const chat = getPersonalChat(from);
          console.log(`✍️ Noah manually replied to ${from}`);
          chat.ownerReplied = true;
          chat.botActive = false;
          if (chat.fallbackTimer) {
            clearTimeout(chat.fallbackTimer);
            chat.fallbackTimer = null;
          }
          chat.messages.push({ role: "assistant", text: text.trim() });
          continue;
        }

        // ── Customer message received ───────────────────────
        console.log(`📨 [PERSONAL] Captured message from ${from}: ${text}`);
        const chat = getPersonalChat(from);
        chat.messages.push({ role: "customer", text: text.trim() });
        chat.lastCustomerMessage = text.trim();

        // Bot already active → Gemini replies immediately
        if (chat.botActive) {
          let reply;
          try {
            reply = await askGemini(chat.messages);
          } catch {
            reply = "Sorry, I'm having a little trouble right now. Please try again shortly. 🙏";
          }
          chat.messages.push({ role: "assistant", text: reply });
          if (chat.messages.length > 20) chat.messages = chat.messages.slice(-20);
          console.log(`🤖 [PERSONAL BOT] Reply to ${from}: ${reply}`);
          await sock.sendMessage(jid, { text: reply });
          continue;
        }

        // Bot not active yet → start or reset the 1 min fallback timer
        chat.ownerReplied = false;
        startFallbackTimer(from, jid, chat);
        console.log(`⏳ Fallback timer running (1 min) for ${from}`);

      } catch (err) {
        console.error("Personal message handler error:", err?.message);
      }
    }
  });
}

// ============================================================
// 1 MIN FALLBACK TIMER
// ============================================================

function startFallbackTimer(from, jid, chat) {
  if (chat.fallbackTimer) clearTimeout(chat.fallbackTimer);

  chat.fallbackTimer = setTimeout(async () => {
    if (!chat.ownerReplied && sock) {
      console.log(`⏰ 20 min passed — bot taking over personal chat with ${from}`);
      chat.botActive = true;

      const unavailableMsg = "Hi! 👋 Stony is not currently available, but I'm the assistant and I'm here to help you.\n\nHow can I assist you please?";

      try {
        await sock.sendMessage(jid, { text: unavailableMsg });
        chat.messages.push({ role: "assistant", text: unavailableMsg });

        if (chat.lastCustomerMessage) {
          let geminiReply;
          try {
            geminiReply = await askGemini(chat.messages);
          } catch {
            geminiReply = "I'm here to help! Could you tell me about your business and what you need? 😊";
          }
          chat.messages.push({ role: "assistant", text: geminiReply });
          await sock.sendMessage(jid, { text: geminiReply });
        }
      } catch (err) {
        console.error("Fallback timer send error:", err?.message);
      }
    }
  }, FALLBACK_DELAY_MS);
}

// ============================================================
// META WEBHOOK VERIFICATION (bot number)
// ============================================================

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

// ============================================================
// BOT NUMBER WEBHOOK (Meta)
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

    console.log(`📨 [BOT NUMBER] From ${from}: ${userText}`);

    const conversation = getBotConversation(from);
    conversation.messages.push({ role: "customer", text: userText });
    updateLeadInformation(conversation, userText);

    if (detectInterest(userText)) {
      console.log(`🔥 Potential client: ${from}`);
      await notifyOwner(from, userText, conversation);
    }

    let reply;
    try {
      reply = await askGemini(conversation.messages);
    } catch (err) {
      console.error("Gemini error:", err?.message);
      reply = "Sorry, I'm having a little trouble responding right now. Please try again in a moment. 🙏";
    }

    if (!reply) reply = "Sorry, I couldn't generate a response right now. Please try again.";

    conversation.messages.push({ role: "assistant", text: reply });
    if (conversation.messages.length > 20) conversation.messages = conversation.messages.slice(-20);

    console.log(`🤖 [BOT NUMBER] Reply to ${from}: ${reply}`);
    await sendBotMessage(from, reply);

  } catch (err) {
    console.error("Bot webhook error:", err?.response?.data || err?.message);
  }
});

// ============================================================
// QR CODE PAGE
// ============================================================

app.get("/qr", (req, res) => {
  if (personalConnected) {
    return res.send("<h2>✅ Personal number is connected!</h2>");
  }
  if (qrString) {
    return res.send(`
      <html>
        <head><title>Scan QR</title></head>
        <body style="text-align:center;font-family:sans-serif;padding:40px">
          <h2>📱 Scan with your personal WhatsApp (0547100951)</h2>
          <p>Open WhatsApp → Linked Devices → Link a Device → Scan</p>
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrString)}" />
          <p><small>Refresh this page if QR expired</small></p>
        </body>
      </html>
    `);
  }
  return res.send("<h2>⏳ QR not ready yet. Refresh in 5 seconds...</h2><script>setTimeout(()=>location.reload(),5000)</script>");
});

// ============================================================
// ROOT & HEALTH
// ============================================================

app.get("/", (req, res) => {
  res.status(200).send(`
    <html><body style="font-family:sans-serif;padding:40px">
    <h2>🚀 Stony_Tech AI Bot is running</h2>
    <p>Bot number: ✅ Active</p>
    <p>Personal number: ${personalConnected ? "✅ Connected" : "❌ Not connected — <a href='/qr'>Click here to scan QR</a>"}</p>
    </body></html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    bot: "Stony_Tech AI Bot",
    personalConnected,
    botChats: botConversations.size,
    personalChats: personalChats.size
  });
});

// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
  console.log(`🚀 Stony_Tech AI Bot running on port ${PORT}`);
  console.log(`👉 Open https://your-render-url.onrender.com/qr to scan QR code`);
});

startPersonalNumber();
