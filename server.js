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
const qrcode = require("qrcode-terminal");
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
if (!GROQ_API_KEY)             console.warn("⚠️  Missing GROQ_API_KEY");
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
// BLOCKED NUMBERS
// ============================================================

const BLOCKED_NUMBERS = {
  main:   ["233599779237", "233550901484", "233599599254", "233243682726"],
  second: ["233535840183", "233267103209", "233547100951"]
};

// Combine all blocked numbers globally
const ALL_BLOCKED_NUMBERS = [...BLOCKED_NUMBERS.main, ...BLOCKED_NUMBERS.second];

// ============================================================
// SMART HELPER: CHECK IF NUMBER IS BLOCKED
// ============================================================

function isBlocked(from, ignoredList = ALL_BLOCKED_NUMBERS) {
  if (!from) return false;
  const cleanFrom = String(from).replace(/\D/g, "");
  
  // Check manual block list only (No faulty 13-digit length traps)
  const matched = ignoredList.some(num => {
    const cleanNum = String(num).replace(/\D/g, "");
    return cleanFrom === cleanNum || cleanFrom.endsWith(cleanNum) || cleanNum.endsWith(cleanFrom);
  });

  if (matched) {
    console.log(`🔍 Block Check -> Incoming: "${from}" | Blocked?: true (Manual List)`);
    return true;
  }

  console.log(`🔍 Block Check -> Incoming: "${from}" (Clean: "${cleanFrom}") | Blocked?: false`);
  return false;
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

  // 1️⃣ Try Gemini First
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await ai.models.generateContent({ model, contents: prompt });
      const reply = result.text?.trim();
      if (reply) return reply;
      throw new Error("Gemini returned empty response.");
    } catch (error) {
      const status = error?.status || error?.response?.status;
      console.error(`Gemini attempt ${attempt} failed:`, error?.message);
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

  // 2️⃣ Fallback to Groq Llama 3
  console.warn("⚠️ Switching to Groq Cloud (Llama 3) fallback...");
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
    console.error("❌ Groq fallback also failed:", groqError?.message);
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
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  baileysSessions[sessionKey].sock = sock;
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      baileysSessions[sessionKey].qr = qr;
      console.log(`\n📱 SCAN THIS QR CODE FOR (${phoneNumber}):`);
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      baileysSessions[sessionKey].connected = true;
      baileysSessions[sessionKey].qr = null;
      console.log(`✅ Number ${phoneNumber} connected via Baileys!`);
    }

    if (connection === "close") {
      baileysSessions[sessionKey].connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`⚠️  Number ${phoneNumber} disconnected. Status: ${statusCode}. Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        console.log(`🔄 Reconnecting ${phoneNumber} in 5 seconds...`);
        setTimeout(() => startBaileysClient(sessionKey, phoneNumber, authFolder), 5000);
      } else {
        console.log(`❌ Logged out ${phoneNumber}. Delete ${authFolder} and restart.`);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.remoteJid === "status@broadcast") continue;

        const jid = msg.key.remoteJid;
        // Ignore non-standard extensions completely
        if (!jid.endsWith("@s.whatsapp.net")) continue;

        const fromMe = msg.key.fromMe;
        const from   = jid.replace("@s.whatsapp.net", "");

        // 🚫 STRICT GLOBAL BLOCK CHECK
        if (isBlocked(from)) {
          console.log(`🚫 Blocked message ignored on Baileys from: +${from}`);
          continue;
        }

        // 🛠️ Unwraps disappearing / ephemeral messages safely
        const baseMsg = msg.message?.ephemeralMessage?.message || msg.message;
        const text = baseMsg?.conversation ||
                     baseMsg?.extendedTextMessage?.text ||
                     baseMsg?.imageMessage?.caption || "";

        if (!text.trim()) {
          console.log(`⚠️ Ignored empty or non-text message from +${from}`);
          continue;
        }

        console.log(`📥 Received text from unblocked +${from}: "${text.trim()}"`);

        // ── You replied manually ──────────────────────────
        if (fromMe) {
          const chat = getPersonalChat(from);
          chat.ownerReplied = true;
          chat.botActive    = false;
          if (chat.fallbackTimer) {
            clearTimeout(chat.fallbackTimer);
            chat.fallbackTimer = null;
          }
          chat.messages.push({ role: "assistant", text: text.trim() });
          console.log(`👤 Owner replied manually to +${from}. Timer cleared.`);
          continue;
        }

        // ── Customer message ──────────────────────────────
        const chat = getPersonalChat(from);
        chat.messages.push({ role: "customer", text: text.trim() });
        chat.lastCustomerMessage = text.trim();

        // Update lead data & check for interest to notify owner via Meta bot
        updateLeadInformation(chat, text.trim());
        if (detectInterest(text.trim())) {
          await notifyOwner(from, text.trim(), chat, `Baileys +${phoneNumber}`);
        }

        // Bot already active → reply immediately
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
          continue;
        }

        // Start fallback timer (runs uninterrupted from the first message)
        console.log(`⏱️ Starting 1-minute fallback timer for unblocked +${from}...`);
        startFallbackTimer(from, jid, chat, sock, phoneNumber);

      } catch (err) {
        console.error(`Message handler error on ${phoneNumber}:`, err?.message);
      }
    }
  });
}

// ============================================================
// FALLBACK TIMER
// ============================================================

function startFallbackTimer(from, jid, chat, activeSock, phoneNumber) {
  if (chat.fallbackTimer || chat.botActive) return;

  chat.ownerReplied = false;

  chat.fallbackTimer = setTimeout(async () => {
    chat.fallbackTimer = null;

    if (isBlocked(from)) return;

    if (!chat.ownerReplied && activeSock) {
      console.log(`⏰ Time passed — bot taking over chat with ${from} via ${phoneNumber}`);
      chat.botActive = true;

      const unavailableMsg = "Hi! 👋 Stony is not currently available, but I'm the assistant and I'm here to help you.\n\nHow can I assist you please?";

      try {
        await activeSock.sendMessage(jid, { text: unavailableMsg });
        chat.messages.push({ role: "assistant", text: unavailableMsg });

        if (chat.lastCustomerMessage) {
          let aiReply;
          try {
            aiReply = await askAI(chat.messages);
          } catch {
            aiReply = "I'm here to help! Could you tell me about your business and what you need? 😊";
          }
          chat.messages.push({ role: "assistant", text: aiReply });
          await activeSock.sendMessage(jid, { text: aiReply });
        }
      } catch (err) {
        console.error("Fallback timer send error:", err?.message);
      }
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

    // 🚫 STRICT GLOBAL BLOCK CHECK
    if (isBlocked(from)) {
      console.log(`🚫 Blocked message ignored on Meta bot from: +${from}`);
      return;
    }

    const conversation = getBotConversation(from);
    conversation.messages.push({ role: "customer", text: userText });
    updateLeadInformation(conversation, userText);

    if (detectInterest(userText)) {
      console.log(`🔥 Potential client on Meta Bot: ${from}`);
      await notifyOwner(from, userText, conversation, "Meta Bot");
    }

    let reply;
    try {
      reply = await askAI(conversation.messages);
    } catch (err) {
      console.error("AI Engine error:", err?.message);
      reply = "Sorry, I'm having a little trouble responding right now. Please try again in a moment. 🙏";
    }

    if (!reply) reply = "Sorry, I couldn't generate a response right now. Please try again.";

    conversation.messages.push({ role: "assistant", text: reply });
    if (conversation.messages.length > 20) conversation.messages = conversation.messages.slice(-20);

    await sendBotMessage(from, reply);

  } catch (err) {
    console.error("Bot webhook error:", err?.response?.data || err?.message);
  }
});

// ============================================================
// BLOCKED NUMBERS PAGE
// ============================================================

app.get("/blocked", (req, res) => {
  const style = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: sans-serif; background: #f4f4f9; padding: 30px; }
      h1 { color: #111; margin-bottom: 6px; }
      .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; }
      .cards { display: flex; gap: 20px; flex-wrap: wrap; }
      .card { background: white; border-radius: 12px; padding: 20px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.08); min-width: 280px; flex: 1; }
      .card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: #22c55e; }
      .dot.off { background: #ef4444; }
      .card-title { font-size: 15px; font-weight: 600; color: #222; }
      .card-phone { font-size: 12px; color: #888; margin-top: 2px; }
      ul { list-style: none; }
      li { display: flex; align-items: center; gap: 10px;
           padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; color: #333; }
      li:last-child { border-bottom: none; }
      .badge { background: #fee2e2; color: #b91c1c; font-size: 10px; font-weight: 700;
               padding: 2px 8px; border-radius: 20px; letter-spacing: 0.5px; }
      .empty { color: #aaa; font-style: italic; font-size: 13px; padding: 10px 0; }
      .total { font-size: 12px; color: #888; margin-top: 12px; }
      .back { display: inline-block; margin-top: 24px; color: #2563eb;
              text-decoration: none; font-size: 13px; }
      .back:hover { text-decoration: underline; }
    </style>
  `;

  const mainConnected   = baileysSessions.main.connected;
  const secondConnected = baileysSessions.second.connected;

  let mainList = "";
  if (BLOCKED_NUMBERS.main.length === 0) {
    mainList = `<li><span class="empty">No blocked numbers</span></li>`;
  } else {
    BLOCKED_NUMBERS.main.forEach(n => {
      mainList += `<li><span class="badge">BLOCKED</span> +${n}</li>`;
    });
  }

  let secondList = "";
  if (BLOCKED_NUMBERS.second.length === 0) {
    secondList = `<li><span class="empty">No blocked numbers</span></li>`;
  } else {
    BLOCKED_NUMBERS.second.forEach(n => {
      secondList += `<li><span class="badge">BLOCKED</span> +${n}</li>`;
    });
  }

  res.send(`
    <html>
      <head><title>Blocked Numbers</title>${style}</head>
      <body>
        <h1>🚫 Blocked Numbers</h1>
        <p class="subtitle">These numbers are globally ignored by all bots.</p>

        <div class="cards">

          <div class="card">
            <div class="card-header">
              <div class="dot ${mainConnected ? "" : "off"}"></div>
              <div>
                <div class="card-title">Main Number</div>
                <div class="card-phone">+${baileysSessions.main.phone} · ${mainConnected ? "Connected" : "Not connected"}</div>
              </div>
            </div>
            <ul>${mainList}</ul>
            <div class="total">${BLOCKED_NUMBERS.main.length} number${BLOCKED_NUMBERS.main.length !== 1 ? "s" : ""} blocked</div>
          </div>

          <div class="card">
            <div class="card-header">
              <div class="dot ${secondConnected ? "" : "off"}"></div>
              <div>
                <div class="card-title">Second Number</div>
                <div class="card-phone">+${baileysSessions.second.phone} · ${secondConnected ? "Connected" : "Not connected"}</div>
              </div>
            </div>
            <ul>${secondList}</ul>
            <div class="total">${BLOCKED_NUMBERS.second.length} number${BLOCKED_NUMBERS.second.length !== 1 ? "s" : ""} blocked</div>
          </div>

        </div>

        <a class="back" href="/">← Back to dashboard</a>
      </body>
    </html>
  `);
});

// ============================================================
// QR CODE PAGE
// ============================================================

app.get("/qr", (req, res) => {
  let html = `
    <html>
      <head>
        <title>Scan WhatsApp QRs</title>
        <style>
          body { font-family: sans-serif; text-align: center; padding: 20px; background: #f4f4f9; }
          .card { background: white; padding: 20px; border-radius: 10px;
                  box-shadow: 0 4px 6px rgba(0,0,0,0.1); display: inline-block;
                  margin: 10px; width: 320px; vertical-align: top; }
          img { border-radius: 10px; border: 1px solid #ddd; padding: 10px; background: white; }
          h2 { color: #333; margin-bottom: 5px; }
          p.status { color: #555; font-weight: bold; }
        </style>
      </head>
      <body>
        <h1>📱 Connect Your Numbers</h1>
        <p>Open WhatsApp → Linked Devices → Link a Device → Scan</p>
  `;

  // Main Number Card
  html += `<div class="card"><h2>Main Number</h2><p>+${baileysSessions.main.phone}</p>`;
  if (baileysSessions.main.connected) {
    html += `<p class="status" style="color:green;">✅ Connected!</p>`;
  } else if (baileysSessions.main.qr) {
    html += `<img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(baileysSessions.main.qr)}" />`;
  } else {
    html += `<p class="status">⏳ Generating QR...</p>`;
  }
  html += `</div>`;

  // Second Number Card
  html += `<div class="card"><h2>Second Number</h2><p>+${baileysSessions.second.phone}</p>`;
  if (baileysSessions.second.connected) {
    html += `<p class="status" style="color:green;">✅ Connected!</p>`;
  } else if (baileysSessions.second.qr) {
    html += `<img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(baileysSessions.second.qr)}" />`;
  } else {
    html += `<p class="status">⏳ Generating QR...</p>`;
  }
  html += `</div>`;

  html += `
        <p><small>This page auto-refreshes every 10 minutes.</small></p>
        <script>setTimeout(() => { location.reload(); }, 600000);</script>
      </body>
    </html>`;

  res.send(html);
});

// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
  res.status(200).send(`
    <html>
      <body style="font-family:sans-serif;padding:40px;background:#f4f4f9;">
        <h2>🚀 Stony_Tech AI Bot</h2>
        <p>Meta Bot: ✅ Active</p>
        <p>Main Number (+${baileysSessions.main.phone}):
          ${baileysSessions.main.connected ? "✅ Connected" : "❌ Not connected"}
        </p>
        <p>Second Number (+${baileysSessions.second.phone}):
          ${baileysSessions.second.connected ? "✅ Connected" : "❌ Not connected"}
        </p>
        <br>
        <p><a href="/qr">📱 Scan QR Codes</a></p>
        <p><a href="/blocked">🚫 View Blocked Numbers</a></p>
        <p><a href="/health">❤️ Health Check</a></p>
      </body>
    </html>
  `);
});

// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    bot: "Stony_Tech AI Bot",
    mainConnected: baileysSessions.main.connected,
    secondConnected: baileysSessions.second.connected,
    totalBlocked: ALL_BLOCKED_NUMBERS.length,
    botChats: botConversations.size,
    personalChats: personalChats.size,
    uptime: process.uptime()
  });
});

// ============================================================
// START SERVER & BOTH BAILEYS CLIENTS
// ============================================================

app.listen(PORT, () => {
  console.log(`🚀 Stony_Tech AI Bot running on port ${PORT}`);
  console.log(`👉 Open /qr to scan QR codes`);
  console.log(`🚫 Open /blocked to view blocked numbers`);

  // Start Main Number
  startBaileysClient("main", baileysSessions.main.phone, AUTH_FOLDER_MAIN);

  // Start Second Number
  startBaileysClient("second", baileysSessions.second.phone, AUTH_FOLDER_SEC);
});
