require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");
const { Groq } = require("groq-sdk");

const makeWASocket =
  require("@whiskeysockets/baileys").default;

const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const fs = require("fs");
const pino = require("pino");

const app = express();

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

// ============================================================
// ENVIRONMENT VARIABLES
// ============================================================

const {
  GEMINI_API_KEY,
  GROQ_API_KEY,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN
} = process.env;

if (!GEMINI_API_KEY) {
  console.warn("⚠️ Missing GEMINI_API_KEY");
}

if (!GROQ_API_KEY) {
  console.warn("⚠️ Missing GROQ_API_KEY");
}

if (!WHATSAPP_ACCESS_TOKEN) {
  console.warn("⚠️ Missing WHATSAPP_ACCESS_TOKEN");
}

if (!WHATSAPP_PHONE_NUMBER_ID) {
  console.warn("⚠️ Missing WHATSAPP_PHONE_NUMBER_ID");
}

if (!WHATSAPP_VERIFY_TOKEN) {
  console.warn("⚠️ Missing WHATSAPP_VERIFY_TOKEN");
}

// ============================================================
// AI
// ============================================================

const ai = GEMINI_API_KEY
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
// CONFIG
// ============================================================

const OWNER_NUMBER = "233547100951";

// IMPORTANT:
// Customer gets 1 minute for owner to manually reply.
const FALLBACK_DELAY_MS = 1 * 60 * 1000;

const AUTH_FOLDER_MAIN = "./baileys_auth";
const AUTH_FOLDER_SEC = "./baileys_auth_second";

// ============================================================
// BLOCKED NUMBERS
// SESSION-SPECIFIC
// ============================================================

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
// CONVERSATION STORES
// ============================================================

const botConversations = new Map();
const personalChats = new Map();

// ============================================================
// BOT CONVERSATION
// ============================================================

function getBotConversation(phone) {
  if (!botConversations.has(phone)) {
    botConversations.set(phone, {
      messages: [],
      notifiedOwner: false,

      lead: {
        name: null,
        business: null,
        businessType: null,
        requirement: null
      }
    });
  }

  return botConversations.get(phone);
}

// ============================================================
// PERSONAL CHAT
// ============================================================

function getPersonalChat(phone) {
  if (!personalChats.has(phone)) {
    personalChats.set(phone, {
      messages: [],

      ownerReplied: false,

      botActive: false,

      fallbackTimer: null,

      lastCustomerMessage: null,

      lastJid: null,

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

// ============================================================
// NORMALIZE PHONE
// ============================================================

function normalizePhone(number) {
  if (!number) return "";

  let value = String(number).trim();

  // Remove JID
  value = value
    .replace("@s.whatsapp.net", "")
    .replace("@lid", "")
    .replace("@hosted", "");

  // Baileys can return device-scoped numbers such as:
  // 233547100951:0@s.whatsapp.net
  //
  // Remove the device part.
  value = value.split(":")[0];

  return value.replace(/\D/g, "");
}

// ============================================================
// CONVERT PHONE TO JID
// ============================================================

function phoneToJid(phone) {
  const clean = normalizePhone(phone);

  if (!clean) return null;

  return `${clean}@s.whatsapp.net`;
}

// ============================================================
// CHECK BLOCKED NUMBER
// ============================================================

function isBlockedForSession(sessionKey, from) {
  const cleanFrom = normalizePhone(from);

  if (!cleanFrom) {
    return false;
  }

  const blockedList =
    BLOCKED_NUMBERS[sessionKey] || [];

  return blockedList.some((number) => {
    const cleanNumber =
      normalizePhone(number);

    return (
      cleanFrom === cleanNumber ||
      cleanFrom.endsWith(cleanNumber) ||
      cleanNumber.endsWith(cleanFrom)
    );
  });
}

// ============================================================
// RESOLVE BAILEYS LID -> PHONE NUMBER
// ============================================================

async function resolveSenderNumber(sock, msg) {
  const key = msg?.key || {};

  const remoteJid = key.remoteJid;

  if (!remoteJid) {
    return null;
  }

  // Normal phone JID
  if (
    remoteJid.endsWith(
      "@s.whatsapp.net"
    )
  ) {
    return {
      phone: normalizePhone(remoteJid),
      jid: remoteJid,
      source: "phone-jid"
    };
  }

  // ==========================================================
  // Try remoteJidAlt first
  // ==========================================================

  const alternatives = [
    key.remoteJidAlt,
    key.participantPn,
    key.senderPn
  ];

  for (const alternative of alternatives) {
    if (
      alternative &&
      String(alternative).includes(
        "@s.whatsapp.net"
      )
    ) {
      const phone =
        normalizePhone(alternative);

      if (phone) {
        return {
          phone,
          jid: phoneToJid(phone),
          source: "message-alt"
        };
      }
    }
  }

  // ==========================================================
  // LID MAPPING
  // ==========================================================

  if (
    remoteJid.endsWith("@lid")
  ) {
    try {
      const lidMapping =
        sock?.signalRepository
          ?.lidMapping;

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
            console.log(
              `🔗 LID resolved: ${remoteJid} → +${phone}`
            );

            return {
              phone,
              jid: phoneToJid(phone),
              source: "lid-mapping"
            };
          }
        }
      }
    } catch (error) {
      console.log(
        `⚠️ LID resolution failed for ${remoteJid}:`,
        error?.message || error
      );
    }
  }

  return null;
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
// INTEREST DETECTION
// ============================================================

function detectInterest(text) {
  const msg =
    text.toLowerCase().trim();

  const patterns = [
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

  return patterns.some((pattern) =>
    msg.includes(pattern)
  );
}

// ============================================================
// LEAD INFORMATION
// ============================================================

function updateLeadInformation(
  conversation,
  text
) {
  const lower =
    text.toLowerCase();

  const businessTypes = [
    "restaurant",
    "food",
    "shop",
    "store",
    "school",
    "salon",
    "barber",
    "hotel",
    "pharmacy",
    "company",
    "business"
  ];

  for (
    const type of businessTypes
  ) {
    if (lower.includes(type)) {
      conversation.lead.businessType =
        type;

      break;
    }
  }
}

// ============================================================
// TEXT EXTRACTOR
// ============================================================

function extractMessageText(msgObj) {
  if (!msgObj) {
    return "";
  }

  if (typeof msgObj === "string") {
    return msgObj;
  }

  if (msgObj.conversation) {
    return msgObj.conversation;
  }

  if (
    msgObj.extendedTextMessage?.text
  ) {
    return msgObj.extendedTextMessage.text;
  }

  if (
    msgObj.imageMessage?.caption
  ) {
    return msgObj.imageMessage.caption;
  }

  if (
    msgObj.videoMessage?.caption
  ) {
    return msgObj.videoMessage.caption;
  }

  if (
    msgObj.documentMessage?.caption
  ) {
    return msgObj.documentMessage.caption;
  }

  if (
    msgObj.buttonsResponseMessage
      ?.selectedButtonId
  ) {
    return msgObj
      .buttonsResponseMessage
      .selectedButtonId;
  }

  if (
    msgObj.buttonsResponseMessage
      ?.selectedDisplayText
  ) {
    return msgObj
      .buttonsResponseMessage
      .selectedDisplayText;
  }

  if (
    msgObj.listResponseMessage?.title
  ) {
    return msgObj
      .listResponseMessage
      .title;
  }

  if (
    msgObj.listResponseMessage
      ?.singleSelectReply
      ?.selectedRowId
  ) {
    return msgObj
      .listResponseMessage
      .singleSelectReply
      .selectedRowId;
  }

  if (
    msgObj.templateButtonReplyMessage
      ?.selectedId
  ) {
    return msgObj
      .templateButtonReplyMessage
      .selectedId;
  }

  if (
    msgObj.interactiveResponseMessage
      ?.body?.text
  ) {
    return msgObj
      .interactiveResponseMessage
      .body.text;
  }

  const innerKeys = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage"
  ];

  for (
    const key of innerKeys
  ) {
    if (
      msgObj[key]?.message
    ) {
      const extracted =
        extractMessageText(
          msgObj[key].message
        );

      if (extracted) {
        return extracted;
      }
    }
  }

  return "";
}

// ============================================================
// AI ENGINE
// ============================================================

async function askAI(messages) {
  const history =
    messages
      .slice(-12)
      .map((message) => {
        return `${message.role}: ${message.text}`;
      })
      .join("\n");

  const prompt = `
BUSINESS RULES:
${BUSINESS_RULES}

CONVERSATION:
${history}

Respond to the customer naturally and concisely.
`.trim();

  const model =
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash";

  // ==========================================================
  // GEMINI
  // ==========================================================

  if (ai) {
    try {
      console.log(
        "🤖 Asking Gemini..."
      );

      const result =
        await ai.models.generateContent({
          model,
          contents: prompt
        });

      const reply =
        result.text?.trim();

      if (reply) {
        console.log(
          "✅ Gemini response received"
        );

        return reply;
      }
    } catch (err) {
      console.error(
        "⚠️ Gemini error:",
        err?.message || err
      );
    }
  }

  // ==========================================================
  // GROQ FALLBACK
  // ==========================================================

  if (groq) {
    try {
      console.log(
        "🔄 Switching to Groq..."
      );

      const chatCompletion =
        await groq.chat.completions.create({
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

          model:
            "llama3-70b-8192",

          temperature: 0.7
        });

      const reply =
        chatCompletion
          .choices?.[0]
          ?.message
          ?.content
          ?.trim();

      if (reply) {
        console.log(
          "✅ Groq response received"
        );

        return reply;
      }
    } catch (err) {
      console.error(
        "⚠️ Groq error:",
        err?.message || err
      );
    }
  }

  return "Hi! Thanks for reaching out. How can I assist you?";
}

// ============================================================
// SEND META WHATSAPP MESSAGE
// ============================================================

async function sendBotMessage(
  to,
  body
) {
  if (
    !WHATSAPP_ACCESS_TOKEN ||
    !WHATSAPP_PHONE_NUMBER_ID
  ) {
    throw new Error(
      "WhatsApp Cloud API credentials are missing."
    );
  }

  const url =
    `https://graph.facebook.com/v23.0/` +
    `${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response =
    await axios.post(
      url,

      {
        messaging_product:
          "whatsapp",

        recipient_type:
          "individual",

        to,

        type: "text",

        text: {
          preview_url: false,
          body
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

// ============================================================
// NOTIFY OWNER
// ============================================================

async function notifyOwner(
  from,
  userText,
  conversation,
  sourceLabel
) {
  if (
    conversation.notifiedOwner
  ) {
    return;
  }

  const lead =
    conversation.lead;

  const message = `
🚨 NEW POTENTIAL CLIENT (${sourceLabel})

📱 Customer: +${from}

💼 Business Type:
${lead.businessType || "Not provided"}

💬 Message:
"${userText}"

🔥 Interest: HIGH
`.trim();

  try {
    await sendBotMessage(
      OWNER_NUMBER,
      message
    );

    conversation.notifiedOwner =
      true;

    console.log(
      `📢 Owner notified about +${from}`
    );
  } catch (err) {
    console.error(
      "❌ Failed to notify owner:",
      err?.message || err
    );
  }
}

// ============================================================
// FALLBACK TIMER
// ============================================================

function startFallbackTimer(
  from,
  jid,
  chat,
  activeSock,
  label,
  sessionKey
) {
  // ==========================================================
  // BLOCK CHECK
  // ==========================================================

  if (
    isBlockedForSession(
      sessionKey,
      from
    )
  ) {
    console.log(
      `🚫 +${from} is blocked on ${label}. Timer NOT started.`
    );

    return;
  }

  // ==========================================================
  // TIMER ALREADY RUNNING
  // ==========================================================

  if (chat.fallbackTimer) {
    console.log(
      `⏳ Timer already running for +${from}`
    );

    return;
  }

  // ==========================================================
  // BOT ALREADY ACTIVE
  // ==========================================================

  if (chat.botActive) {
    console.log(
      `🤖 AI already active for +${from}`
    );

    return;
  }

  chat.ownerReplied = false;

  console.log(
    `⏱️ 1-minute timer STARTED for +${from} on ${label}`
  );

  chat.fallbackTimer =
    setTimeout(
      async () => {
        chat.fallbackTimer =
          null;

        console.log(
          `⏰ 1-minute timer FINISHED for +${from}`
        );

        // ======================================================
        // CHECK BLOCK AGAIN
        // ======================================================

        if (
          isBlockedForSession(
            sessionKey,
            from
          )
        ) {
          console.log(
            `🚫 +${from} is blocked. NO AI REPLY.`
          );

          return;
        }

        // ======================================================
        // OWNER REPLIED
        // ======================================================

        if (
          chat.ownerReplied
        ) {
          console.log(
            `👑 Owner already replied to +${from}. NO AI REPLY.`
          );

          return;
        }

        // ======================================================
        // SOCKET CHECK
        // ======================================================

        if (!activeSock) {
          console.log(
            `❌ No active Baileys socket for +${from}`
          );

          return;
        }

        // ======================================================
        // AI TAKES OVER
        // ======================================================

        console.log(
          `🤖 Owner did not reply after 1 minute. AI TAKING OVER for +${from}`
        );

        chat.botActive = true;

        const unavailableMsg =
          "Hi! 👋 Stony is not currently available, but I'm the assistant and I'm here to help you.\n\nHow can I assist you please?";

        try {
          // ====================================================
          // FINAL BLOCK CHECK BEFORE SENDING
          // ====================================================

          if (
            isBlockedForSession(
              sessionKey,
              from
            )
          ) {
            console.log(
              `🚫 FINAL BLOCK CHECK: +${from} is blocked.`
            );

            chat.botActive = false;

            return;
          }

          await activeSock.sendMessage(
            jid,
            {
              text: unavailableMsg
            }
          );

          chat.messages.push({
            role: "assistant",
            text: unavailableMsg
          });

          console.log(
            `🤖 AI takeover message sent to +${from}`
          );

          // ====================================================
          // AI REPLY
          // ====================================================

          if (
            chat.lastCustomerMessage
          ) {
            const aiReply =
              await askAI(
                chat.messages
              );

            // Final block check again
            if (
              isBlockedForSession(
                sessionKey,
                from
              )
            ) {
              console.log(
                `🚫 +${from} became blocked before AI reply.`
              );

              chat.botActive =
                false;

              return;
            }

            chat.messages.push({
              role: "assistant",
              text: aiReply
            });

            if (
              chat.messages.length >
              20
            ) {
              chat.messages =
                chat.messages.slice(
                  -20
                );
            }

            await activeSock.sendMessage(
              jid,
              {
                text: aiReply
              }
            );

            console.log("");
            console.log(
              "🤖 AI REPLY AFTER 1 MINUTE"
            );

            console.log(
              `📱 To: +${from}`
            );

            console.log(
              `💬 "${aiReply}"`
            );
          }
        } catch (err) {
          console.error(
            `❌ Failed to send AI fallback to +${from}:`,
            err?.message || err
          );

          chat.botActive =
            false;
        }
      },
      FALLBACK_DELAY_MS
    );
}

// ============================================================
// START BAILEYS CLIENT
// ============================================================

async function startBaileysClient(
  sessionKey,
  phoneNumber,
  authFolder
) {
  try {
    console.log("");

    console.log(
      "================================================"
    );

    console.log(
      `🚀 Starting Baileys: ${sessionKey.toUpperCase()}`
    );

    console.log(
      `📱 Number: +${phoneNumber}`
    );

    console.log(
      `📂 Auth folder: ${authFolder}`
    );

    console.log(
      "================================================"
    );

    if (
      !fs.existsSync(authFolder)
    ) {
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

    const {
      version
    } =
      await fetchLatestBaileysVersion();

    const sock =
      makeWASocket({
        version,

        auth: state,

        printQRInTerminal: false,

        logger: pino({
          level: "silent"
        }),

        browser: [
          `Stony_Tech Bot (${phoneNumber})`,
          "Chrome",
          "1.0.0"
        ],

        syncFullHistory: true,

        markOnlineOnConnect: true,

        getMessage:
          async () => ({
            conversation:
              "Hello"
          })
      });

    baileysSessions[
      sessionKey
    ].sock = sock;

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    // ========================================================
    // CONNECTION EVENTS
    // ========================================================

    sock.ev.on(
      "connection.update",
      (update) => {
        const {
          connection,
          qr,
          lastDisconnect
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

          // QR NOT printed in logs.
        }

        if (
          connection === "connecting"
        ) {
          console.log(
            `🔄 Baileys [${sessionKey}] connecting...`
          );
        }

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
            "✅ BAILEYS CONNECTED"
          );

          console.log(
            `📱 Account: ${sessionKey.toUpperCase()}`
          );

          console.log(
            `📞 Number: +${phoneNumber}`
          );

          console.log("");
        }

        if (
          connection === "close"
        ) {
          baileysSessions[
            sessionKey
          ].connected = false;

          console.log("");

          console.log(
            "❌ BAILEYS DISCONNECTED"
          );

          console.log(
            `📱 Account: ${sessionKey.toUpperCase()}`
          );

          console.log(
            `📞 Number: +${phoneNumber}`
          );

          console.log(
            "Reason:",
            lastDisconnect
              ?.error
              ?.message ||
              "Unknown"
          );

          console.log(
            "🔄 Reconnecting in 5 seconds..."
          );

          setTimeout(
            () => {
              startBaileysClient(
                sessionKey,
                phoneNumber,
                authFolder
              );
            },
            5000
          );
        }
      }
    );

    // ========================================================
    // BAILEYS MESSAGE EVENTS
    // ========================================================

    sock.ev.on(
      "messages.upsert",
      async ({
        messages,
        type
      }) => {
        console.log("");

        console.log(
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        );

        console.log(
          "📩 BAILEYS MESSAGE EVENT"
        );

        console.log(
          `📱 Account: ${sessionKey.toUpperCase()}`
        );

        console.log(
          `📨 Event type: ${type}`
        );

        console.log(
          `📦 Messages received: ${messages.length}`
        );

        console.log(
          "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        );

        for (
          const msg of messages
        ) {
          try {
            // ==================================================
            // RAW INFORMATION
            // ==================================================

            const rawJid =
              msg.key?.remoteJid;

            const fromMe =
              Boolean(
                msg.key?.fromMe
              );

            console.log("");

            console.log(
              "----------------------------------------"
            );

            console.log(
              "📥 NEW BAILEYS MESSAGE"
            );

            console.log(
              `🆔 Message ID: ${msg.key?.id || "Unknown"}`
            );

            console.log(
              `📍 Raw JID: ${rawJid || "Unknown"}`
            );

            console.log(
              `👤 From me: ${fromMe}`
            );

            // ==================================================
            // NO JID
            // ==================================================

            if (!rawJid) {
              console.log(
                "⚠️ No remoteJid. Ignoring."
              );

              continue;
            }

            // ==================================================
            // STATUS
            // ==================================================

            if (
              rawJid ===
              "status@broadcast"
            ) {
              console.log(
                "⏭️ Status message ignored."
              );

              continue;
            }

            // ==================================================
            // GROUP
            // ==================================================

            if (
              rawJid.includes("@g.us")
            ) {
              console.log(
                "⏭️ Group message ignored."
              );

              continue;
            }

            // ==================================================
            // ONLY PERSONAL CHAT
            // Accept both phone JID and LID.
            // ==================================================

            const isPhoneJid =
              rawJid.endsWith(
                "@s.whatsapp.net"
              );

            const isLidJid =
              rawJid.endsWith(
                "@lid"
              );

            if (
              !isPhoneJid &&
              !isLidJid
            ) {
              console.log(
                "⏭️ Non-personal WhatsApp message ignored."
              );

              continue;
            }

            // ==================================================
            // RESOLVE PHONE
            // ==================================================

            const resolved =
              await resolveSenderNumber(
                sock,
                msg
              );

            if (!resolved) {
              console.log(
                `⚠️ Could not resolve ${rawJid} to a phone number.`
              );

              console.log(
                "⚠️ Message logged but no automatic reply will be sent."
              );

              continue;
            }

            const from =
              resolved.phone;

            // IMPORTANT:
            // Always use the resolved phone JID for replies.
            const replyJid =
              resolved.jid;

            const label =
              sessionKey === "main"
                ? "Main personal number"
                : "Secondary personal number";

            console.log(
              `📱 From: +${from}`
            );

            console.log(
              `🔗 JID source: ${resolved.source}`
            );

            console.log(
              `📌 Account: ${label}`
            );

            // ==================================================
            // EXTRACT TEXT
            // ==================================================

            let text = "";

            try {
              text =
                extractMessageText(
                  msg.message
                );
            } catch (error) {
              console.error(
                "❌ Message extraction error:",
                error?.message ||
                  error
              );
            }

            text =
              typeof text === "string"
                ? text.trim()
                : "";

            console.log(
              `💬 Extracted text: "${text}"`
            );

            // ==================================================
            // BLOCK CHECK
            // DO THIS BEFORE TIMER/AI
            // ==================================================

            if (
              isBlockedForSession(
                sessionKey,
                from
              )
            ) {
              console.log("");

              console.log(
                "🚫 BLOCKED NUMBER DETECTED"
              );

              console.log(
                `📱 +${from}`
              );

              console.log(
                `📌 Blocked on: ${label}`
              );

              console.log(
                "🚫 NO REPLY"
              );

              console.log(
                "🚫 NO TIMER"
              );

              continue;
            }

            // ==================================================
            // OWNER MESSAGE
            //
            // fromMe=true means the connected WhatsApp account
            // sent this message.
            //
            // This is what cancels the 1-minute timer.
            // ==================================================

            if (fromMe) {
              const chat =
                getPersonalChat(
                  from
                );

              chat.ownerReplied =
                true;

              chat.botActive =
                false;

              chat.lastJid =
                replyJid;

              // Cancel timer
              if (
                chat.fallbackTimer
              ) {
                clearTimeout(
                  chat.fallbackTimer
                );

                chat.fallbackTimer =
                  null;

                console.log(
                  `⏹️ TIMER CANCELLED`
                );

                console.log(
                  `👑 Owner replied to +${from}`
                );
              }

              if (text) {
                chat.messages.push({
                  role: "assistant",
                  text
                });

                if (
                  chat.messages.length >
                  20
                ) {
                  chat.messages =
                    chat.messages.slice(
                      -20
                    );
                }
              }

              console.log("");

              console.log(
                "👑 OWNER MESSAGE"
              );

              console.log(
                `📱 Customer chat: +${from}`
              );

              console.log(
                `💬 "${text}"`
              );

              console.log(
                "🤖 AI will remain inactive because owner replied."
              );

              continue;
            }

            // ==================================================
            // NO TEXT
            // ==================================================

            if (!text) {
              console.log(
                "⚠️ Message received but no text could be extracted."
              );

              console.log(
                "🔍 Message type:",
                Object.keys(
                  msg.message || {}
                )
              );

              continue;
            }

            // ==================================================
            // CUSTOMER MESSAGE
            // ==================================================

            console.log("");

            console.log(
              "📨 CUSTOMER MESSAGE"
            );

            console.log(
              `📱 From: +${from}`
            );

            console.log(
              `💬 "${text}"`
            );

            // ==================================================
            // GET CHAT
            // ==================================================

            const chat =
              getPersonalChat(
                from
              );

            chat.lastJid =
              replyJid;

            chat.messages.push({
              role: "customer",
              text
            });

            chat.lastCustomerMessage =
              text;

            // ==================================================
            // LEAD INFORMATION
            // ==================================================

            updateLeadInformation(
              chat,
              text
            );

            // ==================================================
            // INTEREST DETECTION
            // ==================================================

            if (
              detectInterest(text)
            ) {
              console.log(
                `🔥 High interest detected from +${from}`
              );

              await notifyOwner(
                from,
                text,
                chat,
                label
              );
            }

            // ==================================================
            // BOT ALREADY ACTIVE
            // ==================================================

            if (
              chat.botActive
            ) {
              console.log(
                `🤖 Bot already active for +${from}`
              );

              // Final blocked check
              if (
                isBlockedForSession(
                  sessionKey,
                  from
                )
              ) {
                console.log(
                  `🚫 +${from} is blocked. No AI reply.`
                );

                continue;
              }

              const reply =
                await askAI(
                  chat.messages
                );

              chat.messages.push({
                role: "assistant",
                text: reply
              });

              if (
                chat.messages.length >
                20
              ) {
                chat.messages =
                  chat.messages.slice(
                    -20
                  );
              }

              // Final block check before sending
              if (
                isBlockedForSession(
                  sessionKey,
                  from
                )
              ) {
                console.log(
                  `🚫 +${from} became blocked. AI reply cancelled.`
                );

                continue;
              }

              await sock.sendMessage(
                replyJid,
                {
                  text: reply
                }
              );

              console.log("");

              console.log(
                "🤖 AI REPLY"
              );

              console.log(
                `📱 To: +${from}`
              );

              console.log(
                `💬 "${reply}"`
              );

              continue;
            }

            // ==================================================
            // OWNER NOT YET REPLIED
            //
            // START 1-MINUTE TIMER
            // ==================================================

            startFallbackTimer(
              from,
              replyJid,
              chat,
              sock,
              label,
              sessionKey
            );

          } catch (err) {
            if (
              err?.message?.includes(
                "Bad MAC"
              ) ||
              err?.message?.includes(
                "decrypt"
              )
            ) {
              console.log(
                "⚠️ WhatsApp decryption message ignored."
              );

              continue;
            }

            console.error(
              "❌ MESSAGE HANDLER ERROR:",
              err?.message ||
                err
            );
          }
        }
      }
    );

    console.log(
      `✅ Baileys event listeners registered for ${sessionKey}`
    );

  } catch (error) {
    console.error(
      `❌ Failed to start Baileys ${sessionKey}:`,
      error?.message ||
        error
    );

    setTimeout(
      () => {
        startBaileysClient(
          sessionKey,
          phoneNumber,
          authFolder
        );
      },
      10000
    );
  }
}

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
      token ===
        WHATSAPP_VERIFY_TOKEN
    ) {
      return res
        .status(200)
        .send(challenge);
    }

    return res.sendStatus(403);
  }
);

// ============================================================
// META WEBHOOK
// ============================================================

app.post(
  "/webhook",
  async (req, res) => {
    res.sendStatus(200);

    try {
      const value =
        req.body
          ?.entry?.[0]
          ?.changes?.[0]
          ?.value;

      const message =
        value?.messages?.[0];

      if (
        !message ||
        message.type !== "text"
      ) {
        return;
      }

      const from =
        message.from;

      const userText =
        message.text?.body?.trim();

      if (
        !from ||
        !userText
      ) {
        return;
      }

      console.log("");

      console.log(
        "📩 META WHATSAPP MESSAGE"
      );

      console.log(
        `📱 From: +${from}`
      );

      console.log(
        `💬 "${userText}"`
      );

      const conversation =
        getBotConversation(
          from
        );

      conversation.messages.push({
        role: "customer",
        text: userText
      });

      updateLeadInformation(
        conversation,
        userText
      );

      if (
        detectInterest(
          userText
        )
      ) {
        await notifyOwner(
          from,
          userText,
          conversation,
          "Meta Bot"
        );
      }

      const reply =
        await askAI(
          conversation.messages
        );

      conversation.messages.push({
        role: "assistant",
        text: reply
      });

      if (
        conversation.messages.length >
        20
      ) {
        conversation.messages =
          conversation.messages.slice(
            -20
          );
      }

      await sendBotMessage(
        from,
        reply
      );

      console.log(
        `🤖 Meta bot replied to +${from}: "${reply}"`
      );

    } catch (err) {
      console.error(
        "❌ Meta webhook error:",
        err?.message ||
          err
      );
    }
  }
);

// ============================================================
// BLOCKED NUMBERS DASHBOARD
// ============================================================

app.get(
  "/blocked",
  (req, res) => {
    const main =
      BLOCKED_NUMBERS.main.join(
        "<br>"
      );

    const second =
      BLOCKED_NUMBERS.second.join(
        "<br>"
      );

    res.send(`
      <html>

        <head>
          <title>Blocked Numbers</title>

          <meta
            name="viewport"
            content="width=device-width,initial-scale=1"
          />
        </head>

        <body style="
          font-family:Arial,sans-serif;
          padding:30px;
          background:#f5f5f5;
        ">

          <div style="
            max-width:700px;
            margin:auto;
            background:white;
            padding:25px;
            border-radius:15px;
          ">

            <h1>
              🚫 Blocked Numbers
            </h1>

            <h2>
              Main Number
            </h2>

            <p>
              ${main}
            </p>

            <hr>

            <h2>
              Second Number
            </h2>

            <p>
              ${second}
            </p>

            <br>

            <a href="/">
              ← Back
            </a>

          </div>

        </body>

      </html>
    `);
  }
);

// ============================================================
// QR PAGE
// ============================================================

app.get(
  "/qr",
  (req, res) => {
    let html = `
      <html>

      <head>

        <title>
          Stony_Tech WhatsApp Connections
        </title>

        <meta
          name="viewport"
          content="width=device-width,initial-scale=1"
        />

        <style>

          body {
            font-family: Arial, sans-serif;
            background: #f5f5f5;
            padding: 30px;
            text-align: center;
          }

          .container {
            max-width: 900px;
            margin: auto;
          }

          .card {
            background: white;
            padding: 25px;
            margin: 15px;
            border-radius: 15px;
            box-shadow: 0 5px 20px rgba(0,0,0,0.08);
            display: inline-block;
            vertical-align: top;
            width: 350px;
            max-width: 90%;
          }

          .connected {
            color: green;
            font-weight: bold;
          }

          .waiting {
            color: #d97706;
          }

          img {
            width: 250px;
            height: 250px;
            border-radius: 10px;
          }

          a {
            text-decoration: none;
            color: #111;
          }

        </style>

      </head>

      <body>

        <div class="container">

          <h1>
            📱 Stony_Tech WhatsApp Connections
          </h1>

          <p>
            Scan the QR code with the corresponding WhatsApp account.
          </p>
    `;

    for (
      const [key, session]
      of Object.entries(
        baileysSessions
      )
    ) {
      html += `
        <div class="card">

          <h2>
            ${key.toUpperCase()}
          </h2>

          <p>
            +${session.phone}
          </p>
      `;

      if (
        session.connected
      ) {
        html += `
          <p class="connected">
            ✅ Connected
          </p>
        `;
      } else if (
        session.qr
      ) {
        html += `
          <p>
            Scan this QR code:
          </p>

          <img
            src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(session.qr)}"
            alt="WhatsApp QR Code"
          />
        `;
      } else {
        html += `
          <p class="waiting">
            ⏳ Waiting for QR...
          </p>
        `;
      }

      html += `
        </div>
      `;
    }

    html += `
          <br><br>

          <a href="/">
            ← Back to dashboard
          </a>

        </div>

        <script>

          setTimeout(() => {
            location.reload();
          }, 15000);

        </script>

      </body>

      </html>
    `;

    res.send(html);
  }
);

// ============================================================
// HOME
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.status(200).send(`
      <html>

      <head>

        <title>
          Stony_Tech AI Bot
        </title>

        <meta
          name="viewport"
          content="width=device-width,initial-scale=1"
        />

      </head>

      <body style="
        font-family:Arial,sans-serif;
        padding:40px;
        background:#f5f5f5;
      ">

        <div style="
          max-width:700px;
          margin:auto;
          background:white;
          padding:30px;
          border-radius:15px;
        ">

          <h1>
            🚀 Stony_Tech AI Bot
          </h1>

          <p>
            WhatsApp AI automation system
          </p>

          <hr>

          <p>
            <a href="/qr">
              📱 Connect WhatsApp Numbers
            </a>
          </p>

          <p>
            <a href="/blocked">
              🚫 View Blocked Numbers
            </a>
          </p>

          <p>
            <a href="/health">
              ❤️ Health Check
            </a>
          </p>

        </div>

      </body>

      </html>
    `);
  }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {
    res.status(200).json({
      status: "ok",

      uptime:
        process.uptime(),

      baileys: {
        main:
          baileysSessions
            .main
            .connected,

        second:
          baileysSessions
            .second
            .connected
      }
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
      "=============================================="
    );

    console.log(
      `🚀 Stony_Tech server running on port ${PORT}`
    );

    console.log(
      "=============================================="
    );

    console.log(
      "📱 Starting Main Baileys account..."
    );

    startBaileysClient(
      "main",
      baileysSessions
        .main
        .phone,
      AUTH_FOLDER_MAIN
    );

    console.log(
      "📱 Starting Secondary Baileys account..."
    );

    startBaileysClient(
      "second",
      baileysSessions
        .second
        .phone,
      AUTH_FOLDER_SEC
    );
  }
);
