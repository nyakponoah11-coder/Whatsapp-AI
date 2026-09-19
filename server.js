require("dotenv").config();

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const pino = require("pino");

const { GoogleGenAI } = require("@google/genai");
const { Groq } = require("groq-sdk");

const makeWASocket =
  require("@whiskeysockets/baileys").default;

const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");

// =====================================================
// EXPRESS
// =====================================================

const app = express();

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

// =====================================================
// CONFIG
// =====================================================

const OWNER_NUMBER = "233547100951";

const FALLBACK_DELAY_MS = 1 * 60 * 1000;

const AUTH_FOLDER_MAIN = "./baileys_auth";
const AUTH_FOLDER_SEC = "./baileys_auth_second";

// =====================================================
// BLOCKED NUMBERS
// =====================================================

const BLOCKED_NUMBERS = {
  main: [
    "233599779237",
    "233550901484",
    "233599599254",
    "233243682726"
  ],

  second: [
    "233535840183",
    "233267103209",
    "233547100951"
  ]
};

// =====================================================
// BAILEYS SESSIONS
// =====================================================

const baileysSessions = {
  main: {
    phone: "233547100951",
    qr: null,
    connected: false,
    sock: null
  },

  second: {
    phone: "233533161186",
    qr: null,
    connected: false,
    sock: null
  }
};

// =====================================================
// META CONFIG
// =====================================================

const WHATSAPP_ACCESS_TOKEN =
  process.env.WHATSAPP_ACCESS_TOKEN;

const WHATSAPP_PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID;

const WHATSAPP_VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN;

// =====================================================
// AI CONFIG
// =====================================================

const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY;

const GROQ_API_KEY =
  process.env.GROQ_API_KEY;

const GEMINI_MODEL = "gemini-2.5-flash";

const GROQ_MODEL = "llama3-70b-8192";

const genAI = GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: GEMINI_API_KEY
    })
  : null;

const groq = GROQ_API_KEY
  ? new Groq({
      apiKey: GROQ_API_KEY
    })
  : null;

// =====================================================
// MEMORY
// =====================================================

const personalChats = new Map();

const metaChats = new Map();

// =====================================================
// GET PERSONAL CHAT
// =====================================================

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

      lead: {
        name: null,
        business: null,
        businessType: null,
        requirement: null
      }
    });
  }

  return personalChats.get(phone);
}

// =====================================================
// GET META CHAT
// =====================================================

function getMetaChat(phone) {
  if (!metaChats.has(phone)) {
    metaChats.set(phone, {
      messages: [],

      lastCustomerMessage: null,

      botActive: false,

      leadNotified: false,

      lead: {
        name: null,
        business: null,
        businessType: null,
        requirement: null
      }
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
    .replace(/@s.whatsapp.net/g, "")
    .replace(/@lid/g, "")
    .replace(/@c.us/g, "")
    .replace(/\D/g, "");
}

// =====================================================
// BLOCK CHECK
// =====================================================

function isBlockedForSession(sessionKey, phone) {
  const normalized = normalizePhone(phone);

  if (!normalized) return false;

  const blocked =
    BLOCKED_NUMBERS[sessionKey] || [];

  return blocked.some((number) => {
    const blockedNumber = normalizePhone(number);

    return (
      normalized === blockedNumber ||
      normalized.endsWith(blockedNumber) ||
      blockedNumber.endsWith(normalized)
    );
  });
}

// =====================================================
// MESSAGE TEXT EXTRACTION
// =====================================================

function extractMessageText(message) {
  if (!message) return "";

  if (message.conversation) {
    return message.conversation;
  }

  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }

  if (message.imageMessage?.caption) {
    return message.imageMessage.caption;
  }

  if (message.videoMessage?.caption) {
    return message.videoMessage.caption;
  }

  if (message.documentMessage?.caption) {
    return message.documentMessage.caption;
  }

  if (message.buttonsResponseMessage?.selectedDisplayText) {
    return message.buttonsResponseMessage.selectedDisplayText;
  }

  if (message.listResponseMessage?.title) {
    return message.listResponseMessage.title;
  }

  if (message.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return message.listResponseMessage.singleSelectReply.selectedRowId;
  }

  if (message.templateButtonReplyMessage?.selectedDisplayText) {
    return message.templateButtonReplyMessage.selectedDisplayText;
  }

  if (message.interactiveResponseMessage) {
    return (
      message.interactiveResponseMessage
        ?.body?.text ||
      message.interactiveResponseMessage
        ?.nativeFlowResponseMessage
        ?.paramsJson ||
      ""
    );
  }

  if (message.ephemeralMessage?.message) {
    return extractMessageText(
      message.ephemeralMessage.message
    );
  }

  if (message.viewOnceMessage?.message) {
    return extractMessageText(
      message.viewOnceMessage.message
    );
  }

  return "";
}

// =====================================================
// SAVE MESSAGE
// =====================================================

function saveMessage(chat, role, content) {
  if (!content) return;

  chat.messages.push({
    role,
    content,
    timestamp: Date.now()
  });

  // Keep memory manageable
  if (chat.messages.length > 30) {
    chat.messages = chat.messages.slice(-30);
  }
}

// =====================================================
// LEAD DETECTION
// =====================================================

function detectInterest(text) {
  if (!text) return false;

  const message = text.toLowerCase().trim();

  const phrases = [
    "i'm interested",
    "im interested",
    "i am interested",
    "i want one",
    "i need one",
    "i want a bot",
    "i need a bot",
    "i want you to build",
    "i need you to build",
    "build one for me",
    "build it for me",
    "can you build one",
    "i want to get started",
    "how can i get started",
    "let's do it",
    "lets do it",
    "i need your service",
    "how much is it"
  ];

  return phrases.some((phrase) =>
    message.includes(phrase)
  );
}

// =====================================================
// UPDATE LEAD INFORMATION
// =====================================================

function updateLeadInformation(chat, text) {
  if (!text) return;

  const message = text.toLowerCase();

  if (
    message.includes("restaurant") ||
    message.includes("food") ||
    message.includes("chop bar")
  ) {
    chat.lead.businessType = "Food / Restaurant";
  }

  if (
    message.includes("school") ||
    message.includes("university") ||
    message.includes("college")
  ) {
    chat.lead.businessType = "School / Education";
  }

  if (
    message.includes("shop") ||
    message.includes("store") ||
    message.includes("clothing")
  ) {
    chat.lead.businessType = "Shop / Retail";
  }

  if (
    message.includes("hotel") ||
    message.includes("guest house")
  ) {
    chat.lead.businessType = "Hotel / Hospitality";
  }

  if (
    message.includes("delivery") ||
    message.includes("delivery business")
  ) {
    chat.lead.businessType = "Delivery";
  }

  if (
    message.includes("bot") ||
    message.includes("automation") ||
    message.includes("whatsapp")
  ) {
    chat.lead.requirement = text;
  }
}

// =====================================================
// CONVERSATION PROMPT
// =====================================================

function buildConversationPrompt(messages) {
  const recent = messages.slice(-12);

  return recent
    .map((message) => {
      const role =
        message.role === "user"
          ? "Customer"
          : "Assistant";

      return `${role}: ${message.content}`;
    })
    .join("\n");
}

// =====================================================
// GEMINI
// =====================================================

async function askGemini(messages) {
  if (!genAI) {
    throw new Error("Gemini API key is missing");
  }

  console.log("🧠 Asking Gemini...");

  const conversation =
    buildConversationPrompt(messages);

  const systemPrompt = `
You are the official AI assistant for Stony_Tech.

Stony_Tech builds:
- WhatsApp bots
- AI assistants
- Business automation systems
- WhatsApp ordering systems
- Customer support automation
- Booking systems
- Payment integrations
- Business dashboards
- Custom software

Your job is to speak naturally with customers and understand what they need.

Rules:
- Be friendly.
- Be professional.
- Keep replies reasonably concise.
- Do not sound robotic.
- Do not invent prices.
- If someone asks for pricing, explain that pricing depends on the project requirements.
- Ask useful questions when necessary.
- If the customer wants a WhatsApp bot, ask about their business and what they want the bot to do.
- If they are interested in working with Stony_Tech, guide them toward getting started.
- Do not claim something has been built or completed unless the customer actually confirms it.
`;

  const prompt = `
${systemPrompt}

Conversation:

${conversation}

Reply naturally to the customer.
`;

  const result =
    await genAI.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });

  const text =
    result?.text ||
    result?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("") ||
    "";

  if (!text.trim()) {
    throw new Error(
      "Gemini returned an empty response"
    );
  }

  return text.trim();
}

// =====================================================
// GROQ
// =====================================================

async function askGroq(messages) {
  if (!groq) {
    throw new Error("Groq API key is missing");
  }

  console.log("🔄 Falling back to Groq...");

  const conversation =
    buildConversationPrompt(messages);

  const systemPrompt = `
You are the official AI assistant for Stony_Tech.

Stony_Tech builds WhatsApp bots, AI assistants,
business automation systems, ordering systems,
customer support systems and custom software.

Be friendly, professional and concise.

Do not invent prices.
If pricing is requested, say pricing depends on requirements.
Ask useful questions to understand the customer's business.
`;

  const completion =
    await groq.chat.completions.create({
      model: GROQ_MODEL,

      messages: [
        {
          role: "system",
          content: systemPrompt
        },

        {
          role: "user",
          content: conversation
        }
      ],

      temperature: 0.7,

      max_tokens: 500
    });

  const text =
    completion?.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error(
      "Groq returned an empty response"
    );
  }

  return text.trim();
}

// =====================================================
// AI WITH FALLBACK
// =====================================================

async function askAI(messages) {
  try {
    return await askGemini(messages);
  } catch (geminiError) {
    console.error(
      "❌ Gemini failed:",
      geminiError.message
    );

    try {
      return await askGroq(messages);
    } catch (groqError) {
      console.error(
        "❌ Groq failed:",
        groqError.message
      );

      return "Sorry, I'm having a little trouble responding right now. Please try again shortly.";
    }
  }
}

// =====================================================
// SEND META WHATSAPP MESSAGE
// =====================================================

async function sendBotMessage(to, text) {
  if (
    !WHATSAPP_ACCESS_TOKEN ||
    !WHATSAPP_PHONE_NUMBER_ID
  ) {
    throw new Error(
      "Meta WhatsApp credentials are missing"
    );
  }

  const url =
    `https://graph.facebook.com/v23.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response = await axios.post(
    url,

    {
      messaging_product: "whatsapp",

      to: normalizePhone(to),

      type: "text",

      text: {
        body: text
      }
    },

    {
      headers: {
        Authorization:
          `Bearer ${WHATSAPP_ACCESS_TOKEN}`,

        "Content-Type":
          "application/json"
      }
    }
  );

  return response.data;
}

// =====================================================
// NOTIFY OWNER
// =====================================================

async function notifyOwner(chat, customerPhone) {
  if (chat.leadNotified) return;

  chat.leadNotified = true;

  const businessType =
    chat.lead.businessType ||
    "Not identified";

  const requirement =
    chat.lead.requirement ||
    "Not identified";

  const message = `
🚨 NEW STONY_TECH LEAD

📱 Customer:
+${customerPhone}

🏢 Business:
${businessType}

💡 Requirement:
${requirement}

The customer appears interested in Stony_Tech services.
`;

  try {
    await sendBotMessage(
      OWNER_NUMBER,
      message.trim()
    );

    console.log(
      `📢 Lead notification sent to owner for +${customerPhone}`
    );
  } catch (error) {
    console.error(
      "❌ Failed to notify owner:",
      error.response?.data ||
        error.message
    );
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
// START / RESET FALLBACK TIMER
// =====================================================

function startFallbackTimer(
  sessionKey,
  phone,
  jid
) {
  const normalizedPhone =
    normalizePhone(phone);

  if (
    isBlockedForSession(
      sessionKey,
      normalizedPhone
    )
  ) {
    console.log(
      `🚫 Blocked number +${normalizedPhone} - timer NOT started.`
    );

    return;
  }

  const chat =
    getPersonalChat(normalizedPhone);

  // Always reset old timer
  if (chat.fallbackTimer) {
    clearTimeout(chat.fallbackTimer);

    chat.fallbackTimer = null;

    console.log(
      `🔄 Existing timer reset for +${normalizedPhone}`
    );
  }

  chat.ownerReplied = false;

  chat.lastJid = jid;

  console.log(
    `⏳ Starting 1-minute timer for +${normalizedPhone}`
  );

  chat.fallbackTimer =
    setTimeout(async () => {
      chat.fallbackTimer = null;

      // Check blocked again
      if (
        isBlockedForSession(
          sessionKey,
          normalizedPhone
        )
      ) {
        console.log(
          `🚫 +${normalizedPhone} is blocked. AI takeover cancelled.`
        );

        return;
      }

      // Owner replied
      if (chat.ownerReplied) {
        console.log(
          `👤 Owner already replied to +${normalizedPhone}.`
        );

        return;
      }

      const session =
        baileysSessions[sessionKey];

      if (!session?.sock) {
        console.log(
          `❌ No socket available for ${sessionKey}`
        );

        return;
      }

      chat.botActive = true;

      const takeoverMessage =
        "Hi! 👋 Stony is not currently available, but I'm the assistant and I'm here to help you.\n\nHow can I assist you please?";

      try {
        // Final blocked check
        if (
          isBlockedForSession(
            sessionKey,
            normalizedPhone
          )
        ) {
          console.log(
            `🚫 Blocked before takeover message.`
          );

          chat.botActive = false;

          return;
        }

        // Owner check
        if (chat.ownerReplied) {
          chat.botActive = false;

          return;
        }

        // Send takeover message
        await session.sock.sendMessage(
          jid,
          {
            text: takeoverMessage
          }
        );

        saveMessage(
          chat,
          "assistant",
          takeoverMessage
        );

        console.log(
          `🤖 AI takeover started for +${normalizedPhone}`
        );

        // Owner could have replied while sending
        if (chat.ownerReplied) {
          chat.botActive = false;

          return;
        }

        // Block check
        if (
          isBlockedForSession(
            sessionKey,
            normalizedPhone
          )
        ) {
          chat.botActive = false;

          return;
        }

        console.log(
          `🧠 Generating AI response for +${normalizedPhone}...`
        );

        const aiReply =
          await askAI(chat.messages);

        // Final checks
        if (chat.ownerReplied) {
          console.log(
            `👤 Owner replied while AI was generating. AI message cancelled.`
          );

          chat.botActive = false;

          return;
        }

        if (
          isBlockedForSession(
            sessionKey,
            normalizedPhone
          )
        ) {
          console.log(
            `🚫 Number became blocked before AI response.`
          );

          chat.botActive = false;

          return;
        }

        await session.sock.sendMessage(
          jid,
          {
            text: aiReply
          }
        );

        saveMessage(
          chat,
          "assistant",
          aiReply
        );

        console.log(
          `🤖 AI response sent to +${normalizedPhone}`
        );

      } catch (error) {
        console.error(
          `❌ Personal AI error for +${normalizedPhone}:`,
          error.message
        );
      } finally {
        chat.botActive = false;
      }
    }, FALLBACK_DELAY_MS);
}

// =====================================================
// RESOLVE SENDER NUMBER
// =====================================================

async function resolveSenderNumber(
  sock,
  remoteJid,
  message
) {
  // Normal WhatsApp JID
  if (
    remoteJid?.endsWith(
      "@s.whatsapp.net"
    )
  ) {
    return normalizePhone(remoteJid);
  }

  // Alternative sender JID
  const alt =
    message?.key?.participantAlt ||
    message?.key?.remoteJidAlt;

  if (
    alt?.endsWith(
      "@s.whatsapp.net"
    )
  ) {
    return normalizePhone(alt);
  }

  // LID
  if (
    remoteJid?.endsWith("@lid")
  ) {
    try {
      const lidMapping =
        sock?.signalRepository?.lidMapping;

      if (
        lidMapping &&
        typeof lidMapping.getPNForLID ===
          "function"
      ) {
        const pn =
          await lidMapping.getPNForLID(
            remoteJid
          );

        if (pn) {
          return normalizePhone(pn);
        }
      }
    } catch (error) {
      console.error(
        "❌ LID resolution failed:",
        error.message
      );
    }
  }

  return null;
}

// =====================================================
// START BAILEYS CLIENT
// =====================================================

async function startBaileysClient(
  sessionKey,
  phone,
  authFolder
) {
  console.log(
    `\n🚀 Starting ${sessionKey} personal WhatsApp...`
  );

  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, {
      recursive: true
    });
  }

  const {
    state,
    saveCreds
  } = await useMultiFileAuthState(
    authFolder
  );

  let version;

  try {
    const latest =
      await fetchLatestBaileysVersion();

    version = latest.version;

    console.log(
      `📦 Baileys version for ${sessionKey}:`,
      version
    );
  } catch (error) {
    console.log(
      "⚠️ Could not fetch latest Baileys version."
    );
  }

  const sock = makeWASocket({
    auth: state,

    version,

    logger: pino({
      level: "silent"
    }),

    printQRInTerminal: false,

    browser: [
      "Stony_Tech",
      "Chrome",
      "1.0.0"
    ],

    markOnlineOnConnect: false,

    syncFullHistory: false
  });

  baileysSessions[sessionKey].sock =
    sock;

  sock.ev.on(
    "creds.update",
    saveCreds
  );

  sock.ev.on(
    "connection.update",
    async (update) => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      if (qr) {
        baileysSessions[
          sessionKey
        ].qr = qr;

        console.log(
          `📲 QR generated for ${sessionKey}.`
        );

        console.log(
          `👉 Open /qr on your Render app to scan it.`
        );
      }

      if (connection === "open") {
        baileysSessions[
          sessionKey
        ].connected = true;

        baileysSessions[
          sessionKey
        ].qr = null;

        console.log(
          `✅ ${sessionKey} personal WhatsApp connected.`
        );
      }

      if (connection === "close") {
        baileysSessions[
          sessionKey
        ].connected = false;

        const statusCode =
          new Boom(
            lastDisconnect?.error
          )?.output?.statusCode;

        const shouldReconnect =
          statusCode !==
          DisconnectReason.loggedOut;

        console.log(
          `❌ ${sessionKey} WhatsApp disconnected.`
        );

        if (shouldReconnect) {
          console.log(
            `🔄 Reconnecting ${sessionKey} in 5 seconds...`
          );

          setTimeout(() => {
            startBaileysClient(
              sessionKey,
              phone,
              authFolder
            );
          }, 5000);
        } else {
          console.log(
            `🔐 ${sessionKey} logged out. Delete auth folder and scan QR again.`
          );
        }
      }
    }
  );

  // ===================================================
  // BAILEYS MESSAGES
  // ===================================================

  sock.ev.on(
    "messages.upsert",
    async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg?.message) continue;

          const remoteJid =
            msg.key?.remoteJid;

          if (!remoteJid) continue;

          // Ignore status
          if (
            remoteJid ===
            "status@broadcast"
          ) {
            continue;
          }

          // Ignore groups
          if (
            remoteJid.endsWith("@g.us")
          ) {
            continue;
          }

          // Accept personal chats
          const isPersonal =
            remoteJid.endsWith(
              "@s.whatsapp.net"
            ) ||
            remoteJid.endsWith("@lid");

          if (!isPersonal) {
            continue;
          }

          console.log(
            "\n================================"
          );

          console.log(
            "📩 NEW BAILEYS MESSAGE"
          );

          console.log(
            "================================"
          );

          console.log(
            "Message ID:",
            msg.key?.id
          );

          console.log(
            "Raw JID:",
            remoteJid
          );

          console.log(
            "From me:",
            msg.key?.fromMe
          );

          // =============================================
          // RESOLVE NUMBER
          // =============================================

          const from =
            await resolveSenderNumber(
              sock,
              remoteJid,
              msg
            );

          if (!from) {
            console.log(
              "⚠️ Could not resolve sender number."
            );

            continue;
          }

          console.log(
            "From: +" + from
          );

          // =============================================
          // CHAT
          // =============================================

          const chat =
            getPersonalChat(from);

          chat.jids.add(remoteJid);

          chat.lastJid =
            remoteJid;

          // =============================================
          // OWNER MESSAGE
          // =============================================

          if (msg.key?.fromMe) {
            console.log(
              "👤 MESSAGE FROM OWNER"
            );

            const text =
              extractMessageText(
                msg.message
              );

            if (text) {
              console.log(
                `Owner message: "${text}"`
              );

              // Cancel AI timer
              cancelFallbackTimer(chat);

              // Mark owner replied
              chat.ownerReplied = true;

              // Stop active AI
              chat.botActive = false;

              saveMessage(
                chat,
                "assistant",
                text
              );

              console.log(
                `🛑 Automatic AI disabled for +${from}`
              );
            }

            continue;
          }

          // =============================================
          // BLOCK CHECK
          // =============================================

          if (
            isBlockedForSession(
              sessionKey,
              from
            )
          ) {
            console.log(
              `🚫 BLOCKED: +${from}`
            );

            console.log(
              `🚫 ${sessionKey} will NOT reply.`
            );

            // Cancel any existing timer
            cancelFallbackTimer(chat);

            // Make sure AI is disabled
            chat.botActive = false;

            continue;
          }

          // =============================================
          // EXTRACT TEXT
          // =============================================

          const text =
            extractMessageText(
              msg.message
            );

          if (!text) {
            console.log(
              "⚠️ Message has no readable text."
            );

            continue;
          }

          console.log(
            "📨 CUSTOMER MESSAGE"
          );

          console.log(
            `From: +${from}`
          );

          console.log(
            `"${text}"`
          );

          // =============================================
          // SAVE CUSTOMER MESSAGE
          // =============================================

          saveMessage(
            chat,
            "user",
            text
          );

          chat.lastCustomerMessage =
            Date.now();

          chat.ownerReplied = false;

          // =============================================
          // LEAD INFORMATION
          // =============================================

          updateLeadInformation(
            chat,
            text
          );

          // =============================================
          // LEAD DETECTION
          // =============================================

          if (
            detectInterest(text)
          ) {
            await notifyOwner(
              chat,
              from
            );
          }

          // =============================================
          // AI ALREADY ACTIVE
          // =============================================

          if (chat.botActive) {
            console.log(
              `🤖 AI already active for +${from}`
            );

            const aiReply =
              await askAI(
                chat.messages
              );

            // Check blocked before sending
            if (
              isBlockedForSession(
                sessionKey,
                from
              )
            ) {
              console.log(
                `🚫 Blocked before AI response.`
              );

              continue;
            }

            // Check owner
            if (
              chat.ownerReplied
            ) {
              console.log(
                `👤 Owner replied. AI response cancelled.`
              );

              continue;
            }

            await sock.sendMessage(
              remoteJid,
              {
                text: aiReply
              }
            );

            saveMessage(
              chat,
              "assistant",
              aiReply
            );

            console.log(
              `🤖 Immediate AI reply sent to +${from}`
            );

            continue;
          }

          // =============================================
          // START / RESET TIMER
          // =============================================

          startFallbackTimer(
            sessionKey,
            from,
            remoteJid
          );

        } catch (error) {
          console.error(
            "❌ Baileys message handling error:",
            error.message
          );
        }
      }
    }
  );
}

// =====================================================
// META WEBHOOK VERIFY
// =====================================================

app.get(
  "/webhook",
  (req, res) => {
    const mode =
      req.query["hub.mode"];

    const token =
      req.query["hub.verify_token"];

    const challenge =
      req.query["hub.challenge"];

    if (
      mode === "subscribe" &&
      token === WHATSAPP_VERIFY_TOKEN
    ) {
      console.log(
        "✅ Meta webhook verified."
      );

      return res
        .status(200)
        .send(challenge);
    }

    console.log(
      "❌ Meta webhook verification failed."
    );

    return res
      .sendStatus(403);
  }
);

// =====================================================
// META WEBHOOK
// =====================================================

app.post(
  "/webhook",
  async (req, res) => {
    // Respond immediately to Meta
    res.sendStatus(200);

    try {
      const body = req.body;

      if (
        body.object !==
        "whatsapp_business_account"
      ) {
        return;
      }

      for (
        const entry of
        body.entry || []
      ) {
        for (
          const change of
          entry.changes || []
        ) {
          const value =
            change.value;

          const messages =
            value?.messages || [];

          for (
            const message of
            messages
          ) {
            try {
              const from =
                normalizePhone(
                  message.from
                );

              if (!from) {
                continue;
              }

              // Only text for now
              if (
                message.type !== "text"
              ) {
                console.log(
                  `📥 Meta message from +${from} is type ${message.type}.`
                );

                continue;
              }

              const text =
                message.text?.body ||
                "";

              if (!text.trim()) {
                continue;
              }

              console.log(
                "\n================================"
              );

              console.log(
                "📥 META WHATSAPP MESSAGE"
              );

              console.log(
                "================================"
              );

              console.log(
                `From: +${from}`
              );

              console.log(
                `Message: "${text}"`
              );

              const chat =
                getMetaChat(from);

              chat.lastCustomerMessage =
                Date.now();

              saveMessage(
                chat,
                "user",
                text
              );

              // ==========================================
              // LEAD INFORMATION
              // ==========================================

              updateLeadInformation(
                chat,
                text
              );

              // ==========================================
              // LEAD DETECTION
              // ==========================================

              if (
                detectInterest(text)
              ) {
                await notifyOwner(
                  chat,
                  from
                );
              }

              // ==========================================
              // NO TIMER FOR META
              // ==========================================

              chat.botActive = true;

              console.log(
                `🧠 Generating immediate Meta reply for +${from}...`
              );

              const aiReply =
                await askAI(
                  chat.messages
                );

              // ==========================================
              // SEND IMMEDIATELY
              // ==========================================

              await sendBotMessage(
                from,
                aiReply
              );

              saveMessage(
                chat,
                "assistant",
                aiReply
              );

              console.log(
                `🤖 Meta AI response sent immediately to +${from}`
              );

            } catch (error) {
              console.error(
                "❌ Meta message processing error:"
              );

              console.error(
                error.response?.data ||
                  error.message
              );
            }
          }
        }
      }

    } catch (error) {
      console.error(
        "❌ Meta webhook error:",
        error.response?.data ||
          error.message
      );
    }
  }
);

// =====================================================
// QR PAGE
// =====================================================

app.get(
  "/qr",
  (req, res) => {
    const mainQR =
      baileysSessions.main.qr;

    const secondQR =
      baileysSessions.second.qr;

    const makeQR = (
      title,
      qr,
      connected
    ) => {
      if (connected) {
        return `
          <div class="card">
            <h2>${title}</h2>
            <p class="connected">
              ✅ Connected
            </p>
          </div>
        `;
      }

      if (!qr) {
        return `
          <div class="card">
            <h2>${title}</h2>
            <p>
              ⏳ Waiting for QR code...
            </p>
            <meta http-equiv="refresh" content="5">
          </div>
        `;
      }

      const qrImage =
        "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" +
        encodeURIComponent(qr);

      return `
        <div class="card">
          <h2>${title}</h2>

          <p>
            Scan this QR code with WhatsApp.
          </p>

          <img
            src="${qrImage}"
            width="300"
            height="300"
            alt="WhatsApp QR Code"
          />

          <p>
            WhatsApp → Settings → Linked Devices
            → Link a Device
          </p>
        </div>
      `;
    };

    res.send(`
      <!DOCTYPE html>

      <html>

      <head>

        <meta charset="UTF-8">

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0"
        >

        <title>Stony_Tech WhatsApp QR</title>

        <style>

          body {
            margin: 0;
            padding: 30px;
            font-family: Arial, sans-serif;
            background: #111;
            color: white;
            text-align: center;
          }

          h1 {
            margin-bottom: 30px;
          }

          .container {
            max-width: 900px;
            margin: auto;
          }

          .card {
            background: #1d1d1d;
            padding: 25px;
            margin: 25px auto;
            border-radius: 15px;
            max-width: 380px;
            box-shadow:
              0 10px 30px
              rgba(0,0,0,0.4);
          }

          img {
            background: white;
            padding: 10px;
            border-radius: 10px;
            max-width: 90%;
          }

          .connected {
            color: #00ff88;
            font-weight: bold;
          }

        </style>

      </head>

      <body>

        <div class="container">

          <h1>
            Stony_Tech WhatsApp
          </h1>

          ${makeQR(
            "Main Personal Number",
            mainQR,
            baileysSessions.main.connected
          )}

          ${makeQR(
            "Second Personal Number",
            secondQR,
            baileysSessions.second.connected
          )}

        </div>

      </body>

      </html>
    `);
  }
);

// =====================================================
// HEALTH
// =====================================================

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",

      main: {
        phone:
          baileysSessions.main.phone,

        connected:
          baileysSessions.main.connected
      },

      second: {
        phone:
          baileysSessions.second.phone,

        connected:
          baileysSessions.second.connected
      },

      personalChats:
        personalChats.size,

      metaChats:
        metaChats.size,

      metaConfigured:
        Boolean(
          WHATSAPP_ACCESS_TOKEN &&
          WHATSAPP_PHONE_NUMBER_ID
        ),

      geminiConfigured:
        Boolean(GEMINI_API_KEY),

      groqConfigured:
        Boolean(GROQ_API_KEY)
    });
  }
);

// =====================================================
// HOME
// =====================================================

app.get(
  "/",
  (req, res) => {
    res.send(`
      <html>

      <head>
        <title>Stony_Tech AI Assistant</title>
      </head>

      <body
        style="
          font-family:Arial;
          background:#111;
          color:white;
          text-align:center;
          padding:50px;
        "
      >

        <h1>
          🤖 Stony_Tech AI Assistant
        </h1>

        <p>
          WhatsApp automation system is running.
        </p>

        <p>
          <a
            href="/qr"
            style="
              color:#00ff88;
              font-size:20px;
            "
          >
            Open WhatsApp QR
          </a>
        </p>

        <p>
          <a
            href="/health"
            style="
              color:#00aaff;
              font-size:20px;
            "
          >
            System Health
          </a>
        </p>

      </body>

      </html>
    `);
  }
);

// =====================================================
// 404
// =====================================================

app.use(
  (req, res) => {
    res.status(404).json({
      error: "Route not found"
    });
  }
);

// =====================================================
// START SERVER
// =====================================================

app.listen(
  PORT,
  () => {
    console.log(
      `🚀 Stony_Tech server running on port ${PORT}`
    );

    console.log(
      `🌐 Open /qr to scan WhatsApp QR codes`
    );

    console.log(
      `❤️ Health: /health`
    );

    // ================================================
    // MAIN PERSONAL NUMBER
    // ================================================

    startBaileysClient(
      "main",
      baileysSessions.main.phone,
      AUTH_FOLDER_MAIN
    );

    // ================================================
    // SECOND PERSONAL NUMBER
    // ================================================

    startBaileysClient(
      "second",
      baileysSessions.second.phone,
      AUTH_FOLDER_SEC
    );
  }
);
