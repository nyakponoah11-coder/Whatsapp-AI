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


// ============================================================
// APP CONFIG
// ============================================================

const app = express();

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const WHATSAPP_ACCESS_TOKEN =
  process.env.WHATSAPP_ACCESS_TOKEN;

const WHATSAPP_PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID;

const WHATSAPP_VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN;


// ============================================================
// AI CONFIG
// ============================================================

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || gemini-3.6-flash";

const GROQ_MODEL =
  process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

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


// ============================================================
// NUMBERS
// ============================================================

const OWNER_NUMBER = "233547100951";


// ============================================================
// FALLBACK TIMER
// ============================================================

// 1 minute
const FALLBACK_DELAY_MS = 1 * 60 * 1000;


// ============================================================
// BAILEYS AUTH FOLDERS
// ============================================================

const AUTH_FOLDER_MAIN = "./baileys_auth";
const AUTH_FOLDER_SEC = "./baileys_auth_second";


// ============================================================
// SESSION-SPECIFIC BLOCKED NUMBERS
// ============================================================

const BLOCKED_NUMBERS = {

  // MAIN PERSONAL WHATSAPP
  main: [
    "233599779237",
    "233550901484",
    "233599599254",
    "233243682726"
  ],

  // SECOND PERSONAL WHATSAPP
  second: [
    "233535840183",
    "233267103209",
    "233547100951"
  ]

};


// ============================================================
// BAILEYS SESSIONS
// ============================================================

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


// ============================================================
// PERSONAL CHAT STORAGE
// ============================================================

const personalChats = new Map();


// ============================================================
// LOGGING
// ============================================================

const logger = pino({
  level: "silent"
});


// ============================================================
// BUSINESS INFORMATION
// ============================================================

const BUSINESS_RULES = `
You are Stony_Tech's AI assistant.

Stony_Tech builds custom WhatsApp bots, AI assistants,
automation systems, ordering systems, customer support systems,
booking systems, payment-integrated bots, order management
systems, dashboards and other business automation solutions.

Your job is to speak naturally with potential customers.

Be:
- Friendly
- Professional
- Helpful
- Concise
- Human-like

Do not sound robotic.

Do not invent prices.

If the customer asks about price, explain that pricing depends
on the type and complexity of the system and ask what they want
to build.

If the customer is interested in getting a bot or automation
system, collect useful information such as:
- Business type
- What they want automated
- How customers currently place orders
- Whether they need payments
- Whether they need WhatsApp automation
- Any other important requirement

Do not ask too many questions at once.

If the customer only says hello/hi, respond naturally and ask
what type of business they run or what they need help with.

Keep responses reasonably short because this is WhatsApp.
`;


// ============================================================
// HELPER: NORMALIZE PHONE
// ============================================================

function normalizePhone(value) {

  if (!value) return null;

  let phone = String(value);

  phone = phone
    .replace("@s.whatsapp.net", "")
    .replace("@lid", "")
    .replace("@g.us", "")
    .replace("@broadcast", "")
    .replace(/\D/g, "");

  // Remove device suffix if somehow present
  phone = phone.split(":")[0];

  if (!phone) return null;

  return phone;
}


// ============================================================
// HELPER: BLOCKED NUMBER CHECK
// ============================================================

function isBlockedForSession(sessionKey, phone) {

  const normalized = normalizePhone(phone);

  if (!normalized) return false;

  const blocked =
    BLOCKED_NUMBERS[sessionKey] || [];

  return blocked.some((number) => {

    const blockedNumber =
      normalizePhone(number);

    if (!blockedNumber) return false;

    return (
      normalized === blockedNumber ||
      normalized.endsWith(blockedNumber) ||
      blockedNumber.endsWith(normalized)
    );

  });

}


// ============================================================
// FIND CHAT BY JID
// ============================================================

function findChatByJid(jid) {

  if (!jid) return null;

  for (const [phone, chat] of personalChats.entries()) {

    if (
      chat.lastJid === jid ||
      chat.jids?.has?.(jid)
    ) {

      return {
        phone,
        chat
      };

    }

  }

  return null;
}


// ============================================================
// GET / CREATE PERSONAL CHAT
// ============================================================

function getPersonalChat(phone) {

  const normalized =
    normalizePhone(phone);

  if (!normalized) return null;

  if (!personalChats.has(normalized)) {

    personalChats.set(normalized, {

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

  return personalChats.get(normalized);

}


// ============================================================
// EXTRACT MESSAGE TEXT
// ============================================================

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

  if (message.buttonsResponseMessage?.selectedButtonId) {
    return message.buttonsResponseMessage.selectedButtonId;
  }

  if (message.buttonsResponseMessage?.selectedDisplayText) {
    return message.buttonsResponseMessage.selectedDisplayText;
  }

  if (message.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return message.listResponseMessage.singleSelectReply.selectedRowId;
  }

  if (message.listResponseMessage?.title) {
    return message.listResponseMessage.title;
  }

  if (message.templateButtonReplyMessage?.selectedId) {
    return message.templateButtonReplyMessage.selectedId;
  }

  if (message.interactiveResponseMessage) {

    const nativeFlow =
      message.interactiveResponseMessage
        ?.nativeFlowResponseMessage
        ?.paramsJson;

    if (nativeFlow) {

      try {

        const parsed =
          JSON.parse(nativeFlow);

        return (
          parsed.id ||
          parsed.button_id ||
          parsed.text ||
          ""
        );

      } catch {}

    }

  }

  // Ephemeral
  if (message.ephemeralMessage?.message) {
    return extractMessageText(
      message.ephemeralMessage.message
    );
  }

  // View once
  if (message.viewOnceMessage?.message) {
    return extractMessageText(
      message.viewOnceMessage.message
    );
  }

  // Document with caption
  if (message.documentWithCaptionMessage?.message) {
    return extractMessageText(
      message.documentWithCaptionMessage.message
    );
  }

  return "";
}


// ============================================================
// SAVE MESSAGE
// ============================================================

function saveMessage(
  chat,
  role,
  text
) {

  if (!chat || !text) return;

  chat.messages.push({
    role,
    text,
    timestamp: Date.now()
  });

  // Keep memory under control
  if (chat.messages.length > 50) {
    chat.messages =
      chat.messages.slice(-50);
  }

}


// ============================================================
// DETECT CUSTOMER INTEREST
// ============================================================

function detectInterest(text) {

  if (!text) return false;

  const lower =
    text.toLowerCase().trim();

  const interestPhrases = [

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

  return interestPhrases.some(
    phrase => lower.includes(phrase)
  );

}


// ============================================================
// UPDATE LEAD INFORMATION
// ============================================================

function updateLeadInformation(
  chat,
  text
) {

  if (!chat || !text) return;

  const lower =
    text.toLowerCase();

  // Business types
  const businessTypes = [

    {
      keywords: ["restaurant", "food", "chop bar", "food vendor"],
      type: "Restaurant / Food Business"
    },

    {
      keywords: ["shop", "store", "clothing", "fashion"],
      type: "Shop / Store"
    },

    {
      keywords: ["school", "school management"],
      type: "School"
    },

    {
      keywords: ["salon", "beauty"],
      type: "Salon / Beauty"
    },

    {
      keywords: ["barber", "barbershop"],
      type: "Barbershop"
    },

    {
      keywords: ["hotel", "guest house"],
      type: "Hotel"
    },

    {
      keywords: ["pharmacy", "drug store"],
      type: "Pharmacy"
    },

    {
      keywords: ["company", "business"],
      type: "Business / Company"
    }

  ];

  for (const item of businessTypes) {

    if (
      item.keywords.some(
        keyword => lower.includes(keyword)
      )
    ) {

      chat.lead.businessType =
        item.type;

      break;

    }

  }

  if (!chat.lead.requirement) {

    if (
      lower.includes("bot") ||
      lower.includes("whatsapp") ||
      lower.includes("automation") ||
      lower.includes("ai") ||
      lower.includes("website") ||
      lower.includes("system")
    ) {

      chat.lead.requirement =
        text.substring(0, 500);

    }

  }

}


// ============================================================
// AI PROMPT
// ============================================================

function buildConversationPrompt(
  messages
) {

  const recent =
    messages
      .slice(-12)
      .map(message => {

        const role =
          message.role === "assistant"
            ? "Stony_Tech Assistant"
            : "Customer";

        return `${role}: ${message.text}`;

      })
      .join("\n");

  return `
${BUSINESS_RULES}

Conversation:

${recent}

Respond to the customer's latest message.

Only provide the response that should be sent on WhatsApp.
Do not include labels like "Assistant:".
`;
}


// ============================================================
// ASK GEMINI
// ============================================================

async function askGemini(prompt) {

  if (!genAI) {
    throw new Error("Gemini API key is missing.");
  }

  const response =
    await genAI.models.generateContent({

      model: GEMINI_MODEL,

      contents: prompt

    });

  const text =
    response?.text?.trim();

  if (!text) {
    throw new Error(
      "Gemini returned an empty response."
    );
  }

  return text;

}


// ============================================================
// ASK GROQ
// ============================================================

async function askGroq(prompt) {

  if (!groq) {
    throw new Error("Groq API key is missing.");
  }

  const response =
    await groq.chat.completions.create({

      model: GROQ_MODEL,

      messages: [
        {
          role: "system",
          content: BUSINESS_RULES
        },
        {
          role: "user",
          content: prompt
        }
      ],

      temperature: 0.7,

      max_tokens: 500

    });

  const text =
    response?.choices?.[0]?.message?.content?.trim();

  if (!text) {
    throw new Error(
      "Groq returned an empty response."
    );
  }

  return text;

}


// ============================================================
// ASK AI WITH FALLBACK
// ============================================================

async function askAI(messages) {

  const prompt =
    buildConversationPrompt(messages);

  // Gemini first
  if (genAI) {

    try {

      console.log("🧠 Asking Gemini...");

      return await askGemini(prompt);

    } catch (error) {

      console.log(
        "⚠️ Gemini failed:",
        error.message
      );

    }

  }

  // Groq fallback
  if (groq) {

    try {

      console.log("🧠 Asking Groq...");

      return await askGroq(prompt);

    } catch (error) {

      console.log(
        "⚠️ Groq failed:",
        error.message
      );

    }

  }

  return "Sorry, I'm having trouble responding right now. Please try again shortly.";

}


// ============================================================
// META WHATSAPP SEND MESSAGE
// ============================================================

async function sendBotMessage(
  to,
  text
) {

  const phone =
    normalizePhone(to);

  if (!phone) {
    throw new Error(
      "Invalid WhatsApp recipient."
    );
  }

  if (
    !WHATSAPP_ACCESS_TOKEN ||
    !WHATSAPP_PHONE_NUMBER_ID
  ) {

    throw new Error(
      "Meta WhatsApp API credentials are missing."
    );

  }

  const url =
    `https://graph.facebook.com/v23.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response =
    await axios.post(

      url,

      {
        messaging_product: "whatsapp",

        to: phone,

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
        },

        timeout: 30000
      }

    );

  return response.data;

}


// ============================================================
// NOTIFY OWNER ABOUT LEAD
// ============================================================

async function notifyOwner(
  phone,
  chat
) {

  if (!chat) return;

  if (chat.leadNotified) {
    return;
  }

  chat.leadNotified = true;

  const lead =
    chat.lead || {};

  const message = `
🚨 NEW STONY_TECH LEAD

Customer:
+${phone}

Business:
${lead.businessType || "Not specified"}

Requirement:
${lead.requirement || "Not specified"}

Latest message:
${chat.lastCustomerMessage || "Not available"}

Please check the conversation.
`;

  try {

    await sendBotMessage(
      OWNER_NUMBER,
      message.trim()
    );

    console.log(
      `📢 Lead notification sent for +${phone}`
    );

  } catch (error) {

    chat.leadNotified = false;

    console.log(
      "⚠️ Failed to notify owner:",
      error.response?.data ||
      error.message
    );

  }

}


// ============================================================
// RESOLVE WHATSAPP SENDER NUMBER
// ============================================================

async function resolveSenderNumber(
  sock,
  msg
) {

  const key =
    msg?.key || {};

  const remoteJid =
    key.remoteJid || null;

  const remoteJidAlt =
    key.remoteJidAlt || null;

  const participantPn =
    key.participantPn || null;

  const senderPn =
    key.senderPn || null;


  // ----------------------------------------------------------
  // Normal WhatsApp JID
  // ----------------------------------------------------------

  if (
    remoteJid &&
    remoteJid.endsWith("@s.whatsapp.net")
  ) {

    const phone =
      normalizePhone(remoteJid);

    if (phone) {

      return {
        phone,
        jid: remoteJid,
        source: "remoteJid"
      };

    }

  }


  // ----------------------------------------------------------
  // Alternative phone JID
  // ----------------------------------------------------------

  const possibleJids = [

    remoteJidAlt,
    participantPn,
    senderPn

  ].filter(Boolean);


  for (const jid of possibleJids) {

    if (
      jid.endsWith("@s.whatsapp.net")
    ) {

      const phone =
        normalizePhone(jid);

      if (phone) {

        return {
          phone,
          jid,
          source: "message-alt"
        };

      }

    }

  }


  // ----------------------------------------------------------
  // LID -> PHONE
  // ----------------------------------------------------------

  if (
    remoteJid &&
    remoteJid.endsWith("@lid")
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

          const phone =
            normalizePhone(pn);

          if (phone) {

            return {
              phone,
              jid: remoteJid,
              source: "lidMapping"
            };

          }

        }

      }

    } catch (error) {

      console.log(
        "⚠️ LID resolution failed:",
        error.message
      );

    }

  }


  // ----------------------------------------------------------
  // Check stored JIDs
  // ----------------------------------------------------------

  const existing =
    findChatByJid(remoteJid);

  if (existing) {

    return {
      phone: existing.phone,
      jid: remoteJid,
      source: "stored-jid"
    };

  }


  return null;

}


// ============================================================
// CANCEL FALLBACK TIMER
// ============================================================

function cancelFallbackTimer(
  from,
  chat
) {

  if (!chat) return;

  if (chat.fallbackTimer) {

    clearTimeout(
      chat.fallbackTimer
    );

    chat.fallbackTimer = null;

    console.log(
      `🛑 Fallback timer cancelled for +${from}`
    );

  }

}


// ============================================================
// START / RESET FALLBACK TIMER
// ============================================================

function startFallbackTimer(
  from,
  jid,
  chat,
  activeSock,
  label,
  sessionKey
) {

  // ----------------------------------------------------------
  // FIRST CHECK BLOCKED
  // ----------------------------------------------------------

  if (
    isBlockedForSession(
      sessionKey,
      from
    )
  ) {

    console.log(
      `🚫 +${from} is blocked on ${label}. Timer NOT started.`
    );

    cancelFallbackTimer(
      from,
      chat
    );

    return;

  }


  // ----------------------------------------------------------
  // IF AI IS ALREADY ACTIVE
  // ----------------------------------------------------------

  if (chat.botActive) {

    console.log(
      `🤖 AI already active for +${from}`
    );

    return;

  }


  // ----------------------------------------------------------
  // IMPORTANT:
  // CANCEL OLD TIMER AND RESTART IT
  // ----------------------------------------------------------

  if (chat.fallbackTimer) {

    clearTimeout(
      chat.fallbackTimer
    );

    chat.fallbackTimer = null;

    console.log(
      `🔄 Existing timer reset for +${from}`
    );

  }


  chat.ownerReplied = false;

  chat.lastJid = jid;

  if (!chat.jids) {
    chat.jids = new Set();
  }

  if (jid) {
    chat.jids.add(jid);
  }


  console.log(
    `⏱️ 1-minute timer STARTED for +${from} on ${label}`
  );


  chat.fallbackTimer =
    setTimeout(async () => {

      // ------------------------------------------------------
      // TIMER HAS FIRED
      // ------------------------------------------------------

      chat.fallbackTimer = null;


      // ------------------------------------------------------
      // BLOCK CHECK AGAIN
      // ------------------------------------------------------

      if (
        isBlockedForSession(
          sessionKey,
          from
        )
      ) {

        console.log(
          `🚫 +${from} became blocked. AI will NOT reply.`
        );

        return;

      }


      // ------------------------------------------------------
      // OWNER REPLIED
      // ------------------------------------------------------

      if (chat.ownerReplied) {

        console.log(
          `👤 Owner replied to +${from}. AI takeover cancelled.`
        );

        return;

      }


      // ------------------------------------------------------
      // SOCKET CHECK
      // ------------------------------------------------------

      if (
        !activeSock ||
        !activeSock.user
      ) {

        console.log(
          `⚠️ Socket unavailable for +${from}`
        );

        return;

      }


      // ------------------------------------------------------
      // ACTIVATE AI
      // ------------------------------------------------------

      chat.botActive = true;


      try {

        // ----------------------------------------------------
        // FINAL BLOCK CHECK
        // ----------------------------------------------------

        if (
          isBlockedForSession(
            sessionKey,
            from
          )
        ) {

          console.log(
            `🚫 Final block check stopped AI for +${from}`
          );

          chat.botActive = false;

          return;

        }


        // ----------------------------------------------------
        // CHECK OWNER AGAIN BEFORE TAKEOVER MESSAGE
        // ----------------------------------------------------

        if (chat.ownerReplied) {

          console.log(
            `👤 Owner replied before takeover message for +${from}`
          );

          chat.botActive = false;

          return;

        }


        // ----------------------------------------------------
        // TAKEOVER MESSAGE
        // ----------------------------------------------------

        const takeoverMessage =
          "Hi! 👋 Stony is not currently available, but I'm the assistant and I'm here to help you.\n\nHow can I assist you please?";


        await activeSock.sendMessage(
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
          `🤖 AI takeover message sent to +${from}`
        );


        // ----------------------------------------------------
        // OWNER MAY HAVE REPLIED WHILE MESSAGE WAS SENDING
        // ----------------------------------------------------

        if (chat.ownerReplied) {

          console.log(
            `👤 Owner replied while takeover was processing.`
          );

          chat.botActive = false;

          return;

        }


        // ----------------------------------------------------
        // ASK AI
        // ----------------------------------------------------

        const aiReply =
          await askAI(
            chat.messages
          );


        // ----------------------------------------------------
        // FINAL BLOCK CHECK
        // ----------------------------------------------------

        if (
          isBlockedForSession(
            sessionKey,
            from
          )
        ) {

          console.log(
            `🚫 Final block check stopped AI response to +${from}`
          );

          chat.botActive = false;

          return;

        }


        // ----------------------------------------------------
        // OWNER CHECK BEFORE AI RESPONSE
        // ----------------------------------------------------

        if (chat.ownerReplied) {

          console.log(
            `👤 Owner replied before AI response was sent to +${from}`
          );

          chat.botActive = false;

          return;

        }


        // ----------------------------------------------------
        // SEND AI RESPONSE
        // ----------------------------------------------------

        await activeSock.sendMessage(
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
          `🤖 AI response sent to +${from}`
        );


      } catch (error) {

        console.log(
          `❌ AI takeover error for +${from}:`,
          error.response?.data ||
          error.message
        );

      } finally {

        chat.botActive = false;

      }

    }, FALLBACK_DELAY_MS);

}


// ============================================================
// START BAILEYS CLIENT
// ============================================================

async function startBaileysClient(
  sessionKey,
  phone,
  authFolder
) {

  console.log("");
  console.log(
    `========================================`
  );

  console.log(
    `🚀 Starting ${sessionKey.toUpperCase()} WhatsApp`
  );

  console.log(
    `📱 Number: +${phone}`
  );

  console.log(
    `========================================`
  );


  // Make auth directory if missing
  if (!fs.existsSync(authFolder)) {

    fs.mkdirSync(
      authFolder,
      {
        recursive: true
      }
    );

  }


  const {
    state,
    saveCreds
  } =
    await useMultiFileAuthState(
      authFolder
    );


  let version;

  try {

    const result =
      await fetchLatestBaileysVersion();

    version =
      result.version;

  } catch {

    console.log(
      "⚠️ Could not fetch latest Baileys version. Using default."
    );

  }


  const sock =
    makeWASocket({

      auth: state,

      ...(version
        ? { version }
        : {}),

      logger,

      printQRInTerminal: false,

      browser: [
        "Stony_Tech",
        "Chrome",
        "1.0.0"
      ],

      markOnlineOnConnect: false,

      syncFullHistory: false

    });


  baileysSessions[
    sessionKey
  ].sock = sock;


  // ========================================================
  // SAVE CREDENTIALS
  // ========================================================

  sock.ev.on(
    "creds.update",
    saveCreds
  );


  // ========================================================
  // CONNECTION UPDATE
  // ========================================================

  sock.ev.on(
    "connection.update",
    async (update) => {

      const {
        connection,
        lastDisconnect,
        qr
      } = update;


      // ----------------------------------------------------
      // QR GENERATED
      // ----------------------------------------------------

      if (qr) {

        baileysSessions[
          sessionKey
        ].qr = qr;

        console.log("");
        console.log(
          `📲 QR generated for ${sessionKey}.`
        );

        console.log(
          `👉 Open /qr on your Render app to scan it.`
        );

      }


      // ----------------------------------------------------
      // CONNECTED
      // ----------------------------------------------------

      if (
        connection === "open"
      ) {

        baileysSessions[
          sessionKey
        ].connected = true;

        baileysSessions[
          sessionKey
        ].qr = null;

        console.log("");
        console.log(
          `✅ ${sessionKey.toUpperCase()} WhatsApp connected successfully.`
        );

        console.log(
          `📱 +${phone}`
        );

      }


      // ----------------------------------------------------
      // CLOSED
      // ----------------------------------------------------

      if (
        connection === "close"
      ) {

        baileysSessions[
          sessionKey
        ].connected = false;

        const statusCode =
          lastDisconnect
            ?.error
            ?.output
            ?.statusCode;


        console.log("");
        console.log(
          `❌ ${sessionKey.toUpperCase()} WhatsApp disconnected.`
        );

        console.log(
          `Status code: ${statusCode || "unknown"}`
        );


        // --------------------------------------------------
        // LOGGED OUT
        // --------------------------------------------------

        if (
          statusCode ===
          DisconnectReason.loggedOut
        ) {

          console.log(
            `🚪 ${sessionKey} session logged out.`
          );

          return;

        }


        // --------------------------------------------------
        // RECONNECT
        // --------------------------------------------------

        console.log(
          `🔄 Reconnecting ${sessionKey}...`
        );


        setTimeout(() => {

          startBaileysClient(
            sessionKey,
            phone,
            authFolder
          ).catch(error => {

            console.log(
              `❌ Reconnect error for ${sessionKey}:`,
              error.message
            );

          });

        }, 5000);

      }

    }
  );


  // ========================================================
  // INCOMING / OUTGOING MESSAGES
  // ========================================================

  sock.ev.on(
    "messages.upsert",
    async ({
      messages,
      type
    }) => {

      if (
        !messages ||
        !Array.isArray(messages)
      ) {
        return;
      }


      for (
        const msg of messages
      ) {

        try {

          if (!msg?.message) {
            continue;
          }


          const key =
            msg.key || {};

          const remoteJid =
            key.remoteJid || "";

          const fromMe =
            key.fromMe === true;


          // ------------------------------------------------
          // IGNORE STATUS
          // ------------------------------------------------

          if (
            remoteJid ===
            "status@broadcast"
          ) {
            continue;
          }


          // ------------------------------------------------
          // IGNORE GROUPS
          // ------------------------------------------------

          if (
            remoteJid.endsWith("@g.us")
          ) {

            console.log(
              "⏭️ Group message ignored."
            );

            continue;

          }


          // ------------------------------------------------
          // ACCEPT PERSONAL CHAT
          // ------------------------------------------------

          const isPersonal =
            remoteJid.endsWith(
              "@s.whatsapp.net"
            ) ||
            remoteJid.endsWith("@lid");


          if (!isPersonal) {

            console.log(
              "⏭️ Non-personal WhatsApp message ignored."
            );

            continue;

          }


          console.log("");
          console.log(
            "========================================"
          );

          console.log(
            "📩 NEW BAILEYS MESSAGE"
          );

          console.log(
            "Message ID:",
            key.id
          );

          console.log(
            "Raw JID:",
            remoteJid
          );

          console.log(
            "From me:",
            fromMe
          );


          // ------------------------------------------------
          // RESOLVE PHONE NUMBER
          // ------------------------------------------------

          const resolved =
            await resolveSenderNumber(
              sock,
              msg
            );


          if (!resolved) {

            console.log(
              "⚠️ Could not resolve sender phone number."
            );

            console.log(
              "⏭️ Message ignored to prevent incorrect replies."
            );

            continue;

          }


          const from =
            resolved.phone;

          const jid =
            resolved.jid || remoteJid;


          console.log(
            `From: +${from}`
          );

          console.log(
            `JID source: ${resolved.source}`
          );

          console.log(
            `Account: ${
              sessionKey === "main"
                ? "Main personal number"
                : "Second personal number"
            }`
          );


          // ------------------------------------------------
          // SESSION-SPECIFIC BLOCK CHECK
          // ------------------------------------------------

          const blocked =
            isBlockedForSession(
              sessionKey,
              from
            );


          if (blocked) {

            console.log(
              `🚫 BLOCKED NUMBER: +${from}`
            );

            console.log(
              `🚫 Session: ${sessionKey}`
            );

            console.log(
              "🚫 NO REPLY WILL BE SENT."
            );

            // Make absolutely sure an existing
            // timer is also cancelled.
            const blockedChat =
              getPersonalChat(from);

            cancelFallbackTimer(
              from,
              blockedChat
            );

            blockedChat.botActive =
              false;

            continue;

          }


          // ------------------------------------------------
          // GET CHAT
          // ------------------------------------------------

          const chat =
            getPersonalChat(from);


          if (!chat) {
            continue;
          }


          chat.lastJid =
            jid;

          if (!chat.jids) {
            chat.jids = new Set();
          }

          chat.jids.add(jid);


          // ------------------------------------------------
          // EXTRACT TEXT
          // ------------------------------------------------

          const text =
            extractMessageText(
              msg.message
            ).trim();


          console.log(
            `Extracted text: "${text}"`
          );


          // =================================================
          // OWNER / MANUAL REPLY
          // =================================================

          if (fromMe) {

            console.log(
              `👤 OWNER MESSAGE on ${sessionKey}`
            );


            // Cancel fallback timer immediately
            cancelFallbackTimer(
              from,
              chat
            );


            chat.ownerReplied =
              true;

            chat.botActive =
              false;


            if (text) {

              saveMessage(
                chat,
                "assistant",
                text
              );

            }


            console.log(
              `✅ Manual reply detected for +${from}`
            );

            console.log(
              "🤖 AI takeover cancelled."
            );

            continue;

          }


          // =================================================
          // CUSTOMER MESSAGE
          // =================================================

          console.log(
            "👤 CUSTOMER MESSAGE"
          );

          console.log(
            `From: +${from}`
          );

          console.log(
            `"${text}"`
          );


          if (!text) {

            console.log(
              "⏭️ No text content. Ignored."
            );

            continue;

          }


          // ------------------------------------------------
          // STORE CUSTOMER MESSAGE
          // ------------------------------------------------

          chat.lastCustomerMessage =
            text;

          saveMessage(
            chat,
            "user",
            text
          );


          // ------------------------------------------------
          // UPDATE LEAD
          // ------------------------------------------------

          updateLeadInformation(
            chat,
            text
          );


          // ------------------------------------------------
          // INTEREST DETECTION
          // ------------------------------------------------

          if (
            detectInterest(text)
          ) {

            console.log(
              `🔥 Customer +${from} appears interested.`
            );

            await notifyOwner(
              from,
              chat
            );

          }


          // =================================================
          // AI ALREADY ACTIVE
          // =================================================

          if (chat.botActive) {

            console.log(
              `🤖 AI already active for +${from}`
            );


            // FINAL BLOCK CHECK
            if (
              isBlockedForSession(
                sessionKey,
                from
              )
            ) {

              console.log(
                `🚫 Blocked check stopped AI for +${from}`
              );

              continue;

            }


            // Ask AI
            const aiReply =
              await askAI(
                chat.messages
              );


            // Check blocked again
            if (
              isBlockedForSession(
                sessionKey,
                from
              )
            ) {

              console.log(
                `🚫 Final blocked check stopped AI reply to +${from}`
              );

              continue;

            }


            // Check owner reply again
            if (chat.ownerReplied) {

              console.log(
                `👤 Owner replied. AI will not send response to +${from}`
              );

              continue;

            }


            try {

              await sock.sendMessage(
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
                `🤖 AI response sent to +${from}`
              );

            } catch (error) {

              console.log(
                `❌ Failed to send AI response to +${from}:`,
                error.message
              );

            }


            continue;

          }


          // =================================================
          // START / RESET 1-MINUTE TIMER
          // =================================================

          startFallbackTimer(
            from,
            jid,
            chat,
            sock,
            sessionKey === "main"
              ? "Main personal number"
              : "Second personal number",
            sessionKey
          );


        } catch (error) {

          console.log(
            "❌ Message processing error:",
            error.response?.data ||
            error.message
          );

        }

      }

    }
  );


  return sock;

}


// ============================================================
// QR PAGE
// ============================================================

app.get(
  "/qr",
  (req, res) => {

    const mainQR =
      baileysSessions.main.qr;

    const secondQR =
      baileysSessions.second.qr;


    const mainStatus =
      baileysSessions.main.connected
        ? "CONNECTED"
        : mainQR
          ? "QR READY"
          : "WAITING";


    const secondStatus =
      baileysSessions.second.connected
        ? "CONNECTED"
        : secondQR
          ? "QR READY"
          : "WAITING";


    const mainQRImage =
      mainQR
        ? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(mainQR)}`
        : "";


    const secondQRImage =
      secondQR
        ? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(secondQR)}`
        : "";


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
  font-family: Arial, sans-serif;
  background: #111;
  color: white;
  text-align: center;
  margin: 0;
  padding: 30px;
}

.container {
  max-width: 900px;
  margin: auto;
}

.card {
  background: #1c1c1c;
  border-radius: 15px;
  padding: 25px;
  margin: 20px auto;
  max-width: 400px;
}

h1 {
  margin-bottom: 10px;
}

.status {
  margin: 15px 0;
  font-weight: bold;
}

img {
  width: 300px;
  max-width: 100%;
  background: white;
  padding: 10px;
  border-radius: 10px;
}

.waiting {
  padding: 40px 10px;
  color: #aaa;
}

.refresh {
  margin-top: 20px;
  padding: 12px 20px;
  border: none;
  border-radius: 8px;
  background: #25D366;
  color: white;
  font-size: 16px;
  cursor: pointer;
}

</style>

</head>

<body>

<div class="container">

<h1>Stony_Tech WhatsApp</h1>

<p>Scan the QR code with the corresponding WhatsApp account.</p>


<div class="card">

<h2>Main Number</h2>

<div class="status">
Status: ${mainStatus}
</div>

${
  mainQR
    ? `
      <img
        src="${mainQRImage}"
        alt="Main WhatsApp QR"
      >

      <p>Scan with +${baileysSessions.main.phone}</p>
    `
    : `
      <div class="waiting">
        ${
          baileysSessions.main.connected
            ? "Main number is already connected."
            : "Waiting for QR code..."
        }
      </div>
    `
}

</div>


<div class="card">

<h2>Second Number</h2>

<div class="status">
Status: ${secondStatus}
</div>

${
  secondQR
    ? `
      <img
        src="${secondQRImage}"
        alt="Second WhatsApp QR"
      >

      <p>Scan with +${baileysSessions.second.phone}</p>
    `
    : `
      <div class="waiting">
        ${
          baileysSessions.second.connected
            ? "Second number is already connected."
            : "Waiting for QR code..."
        }
      </div>
    `
}

</div>


<button
  class="refresh"
  onclick="location.reload()"
>
Refresh QR
</button>

</div>

</body>

</html>

`);

  }
);


// ============================================================
// HOME PAGE
// ============================================================

app.get(
  "/",
  (req, res) => {

    res.send(`

<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>Stony_Tech</title>

<style>

body {
  font-family: Arial, sans-serif;
  background: #111;
  color: white;
  text-align: center;
  padding: 50px 20px;
}

a {
  display: inline-block;
  margin-top: 20px;
  padding: 12px 22px;
  background: #25D366;
  color: white;
  text-decoration: none;
  border-radius: 8px;
}

</style>

</head>

<body>

<h1>Stony_Tech WhatsApp Assistant</h1>

<p>WhatsApp automation system is running.</p>

<a href="/qr">
Scan WhatsApp QR
</a>

</body>

</html>

`);

  }
);


// ============================================================
// HEALTH CHECK
// ============================================================

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

      activeChats:
        personalChats.size,

      uptime:
        process.uptime()

    });

  }
);


// ============================================================
// META WEBHOOK VERIFICATION
// ============================================================

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


    return res
      .sendStatus(403);

  }
);


// ============================================================
// META WEBHOOK RECEIVER
// ============================================================

app.post(
  "/webhook",
  async (req, res) => {

    // Respond immediately to Meta
    res.sendStatus(200);


    try {

      const body =
        req.body;


      if (
        body.object !== "whatsapp_business_account"
      ) {
        return;
      }


      const entries =
        body.entry || [];


      for (
        const entry of entries
      ) {

        const changes =
          entry.changes || [];


        for (
          const change of changes
        ) {

          const value =
            change.value;


          if (!value) {
            continue;
          }


          const messages =
            value.messages || [];


          for (
            const message of messages
          ) {

            if (
              message.type !== "text"
            ) {
              continue;
            }


            const from =
              normalizePhone(
                message.from
              );


            const text =
              message.text?.body?.trim();


            if (!from || !text) {
              continue;
            }


            console.log(
              `📥 Meta message from +${from}: "${text}"`
            );


            // This section can be used for
            // Meta Cloud API conversations if needed.
            // Personal Baileys messages are handled
            // separately above.

          }

        }

      }

    } catch (error) {

      console.log(
        "❌ Meta webhook error:",
        error.message
      );

    }

  }
);


// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {

    res.status(404).json({
      error: "Route not found"
    });

  }
);


// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
  (error, req, res, next) => {

    console.error(
      "❌ Express error:",
      error
    );

    res.status(500).json({
      error: "Internal server error"
    });

  }
);


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {

    console.log("");
    console.log(
      "========================================"
    );

    console.log(
      "🚀 STONY_TECH SERVER STARTED"
    );

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      "========================================"
    );

    console.log(
      `📲 QR PAGE: /qr`
    );

    console.log(
      `❤️ HEALTH: /health`
    );

    console.log(
      `⏱️ AI FALLBACK: 1 minute`
    );

    console.log(
      `🚫 Blocked numbers: ENABLED`
    );

    console.log(
      `🤖 Gemini: ${
        GEMINI_API_KEY
          ? "configured"
          : "missing"
      }`
    );

    console.log(
      `🤖 Groq: ${
        GROQ_API_KEY
          ? "configured"
          : "missing"
      }`);

    console.log("");
    console.log(
      "📱 Main WhatsApp: +" +
      baileysSessions.main.phone
    );

    console.log(
      "📱 Second WhatsApp: +" +
      baileysSessions.second.phone
    );

    console.log("");
    console.log(
      "========================================"
    );

    // --------------------------------------------------------
    // START MAIN
    // --------------------------------------------------------

    startBaileysClient(
      "main",
      baileysSessions.main.phone,
      AUTH_FOLDER_MAIN
    ).catch(error => {

      console.log(
        "❌ Main WhatsApp startup error:",
        error.message
      );

    });


    // --------------------------------------------------------
    // START SECOND
    // --------------------------------------------------------

    startBaileysClient(
      "second",
      baileysSessions.second.phone,
      AUTH_FOLDER_SEC
    ).catch(error => {

      console.log(
        "❌ Second WhatsApp startup error:",
        error.message
      );

    });

  }
);
