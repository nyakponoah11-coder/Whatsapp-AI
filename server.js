require("dotenv").config();

const express = require("express");
const axios = require("axios");
const qrcode = require("qrcode-terminal");
const pino = require("pino");

const { GoogleGenAI } = require("@google/genai");
const Groq = require("groq-sdk");

const makeWASocket = require("@whiskeysockets/baileys").default;

const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");

/* ============================================================================
   APP
============================================================================ */

const app = express();

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

/* ============================================================================
   ENVIRONMENT VARIABLES
============================================================================ */

const {
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.5-flash",

  GROQ_API_KEY,
  GROQ_MODEL = "llama-3.3-70b-versatile",

  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,

  OWNER_NUMBER = "233547100951",

  MAIN_BAILEYS_PHONE = "233547100951",
  SECOND_BAILEYS_PHONE = "233533161186"
} = process.env;

/* ============================================================================
   CLIENTS
============================================================================ */

const gemini = GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: GEMINI_API_KEY
    })
  : null;

const groq = GROQ_API_KEY
  ? new Groq({
      apiKey: GROQ_API_KEY
    })
  : null;

/* ============================================================================
   SETTINGS
============================================================================ */

const FALLBACK_DELAY_MS = 1 * 60 * 1000;

const AUTH_FOLDER_MAIN = "./baileys_auth";
const AUTH_FOLDER_SEC = "./baileys_auth_second";

/* ============================================================================
   ACCOUNT-SPECIFIC BLOCKED NUMBERS
============================================================================ */

/*
  IMPORTANT:

  Numbers inside "main" are blocked ONLY on the MAIN personal WhatsApp.

  Numbers inside "second" are blocked ONLY on the SECOND personal WhatsApp.

  A blocked number will:
  - still appear in logs
  - NOT receive AI reply
  - NOT receive fallback reply
  - NOT start fallback timer
  - NOT trigger owner notification
  - NOT be added to active conversation
*/

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

/* ============================================================================
   NORMALIZE PHONE
============================================================================ */

function normalizePhone(number) {
  if (!number) return "";

  return String(number).replace(/\D/g, "");
}

/* ============================================================================
   CHECK BLOCKED NUMBER FOR SPECIFIC ACCOUNT
============================================================================ */

function isBlockedForSession(sessionKey, from) {
  if (!from) return false;

  const cleanFrom = normalizePhone(from);

  const blockedList = BLOCKED_NUMBERS[sessionKey] || [];

  return blockedList.some((number) => {
    const cleanNumber = normalizePhone(number);

    return (
      cleanFrom === cleanNumber ||
      cleanFrom.endsWith(cleanNumber) ||
      cleanNumber.endsWith(cleanFrom)
    );
  });
}

/* ============================================================================
   CHAT STORAGE
============================================================================ */

const personalChats = {
  main: new Map(),
  second: new Map()
};

const metaChats = new Map();

/* ============================================================================
   BOT OUTGOING MESSAGE TRACKING
============================================================================ */

/*
  This prevents a message sent by the bot itself from being mistaken for
  a manual reply from the owner.

  Example:

  Bot sends:
  "Thanks for your message..."

  Baileys reports that as fromMe=true.

  Without this protection, the system could think the OWNER manually replied
  and cancel the fallback timer.

  We temporarily remember bot-generated outgoing messages.
*/

const pendingBotMessages = new Map();

/*
  key:
  sessionKey + ":" + jid

  value:
  {
    text,
    expiresAt
  }
*/

function botMessageKey(sessionKey, jid) {
  return `${sessionKey}:${jid}`;
}

function rememberBotMessage(sessionKey, jid, text) {
  const key = botMessageKey(sessionKey, jid);

  pendingBotMessages.set(key, {
    text: String(text || "").trim(),
    expiresAt: Date.now() + 15000
  });
}

function isRecentBotMessage(sessionKey, jid, text) {
  const key = botMessageKey(sessionKey, jid);

  const record = pendingBotMessages.get(key);

  if (!record) return false;

  if (Date.now() > record.expiresAt) {
    pendingBotMessages.delete(key);
    return false;
  }

  const incomingText = String(text || "").trim();

  if (record.text === incomingText) {
    pendingBotMessages.delete(key);
    return true;
  }

  return false;
}

/* ============================================================================
   GET PERSONAL CHAT
============================================================================ */

function getPersonalChat(sessionKey, from) {
  const cleanFrom = normalizePhone(from);

  const store = personalChats[sessionKey];

  if (!store.has(cleanFrom)) {
    store.set(cleanFrom, {
      phone: cleanFrom,

      messages: [],

      ownerReplied: false,

      botActive: false,

      fallbackTimer: null,

      notifiedOwner: false,

      lead: {
        name: "",
        businessName: "",
        businessType: "",
        needs: "",
        features: "",
        timeline: "",
        budget: ""
      }
    });
  }

  return store.get(cleanFrom);
}

/* ============================================================================
   GET META CHAT
============================================================================ */

function getMetaChat(from) {
  const cleanFrom = normalizePhone(from);

  if (!metaChats.has(cleanFrom)) {
    metaChats.set(cleanFrom, {
      phone: cleanFrom,

      messages: [],

      botActive: true,

      notifiedOwner: false,

      lead: {
        name: "",
        businessName: "",
        businessType: "",
        needs: "",
        features: "",
        timeline: "",
        budget: ""
      }
    });
  }

  return metaChats.get(cleanFrom);
}

/* ============================================================================
   BUSINESS RULES
============================================================================ */

const BUSINESS_RULES = `
You are Stony_Tech's personal AI assistant.

Business:
Stony_Tech builds custom WhatsApp bots, AI assistants and business automation
systems.

Services include:

- WhatsApp AI chatbots
- WhatsApp ordering bots
- Restaurant ordering systems
- Customer service bots
- Business enquiry bots
- Booking and reservation bots
- Automated support bots
- Payment-integrated bots
- Order management systems
- AI business assistants
- Custom business automation
- Admin dashboards

IMPORTANT RULES:

1. Be friendly and professional.
2. Keep WhatsApp replies short and natural.
3. Do not write unnecessarily long messages.
4. Do not invent prices.
5. If someone asks for pricing, explain that pricing depends on the features
   and complexity required.
6. Do not promise a specific delivery date.
7. Do not claim that a human team has received information unless the system
   actually notified the owner.
8. You are Stony_Tech's personal assistant.
9. Do not pretend to be a human.
10. If someone wants a bot, ask useful questions such as:
    - What type of business do you run?
    - What should the bot do?
    - Do customers need to order, book, make enquiries or get support?
11. If the customer is clearly interested, say:

"Great 👍 I'll pass your details to the Stony_Tech team and they'll personally
follow up with you."

12. Do not make up services that Stony_Tech does not provide.
`;

/* ============================================================================
   INTEREST DETECTION
============================================================================ */

const INTEREST_PATTERNS = [
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
  "can you build this",
  "can you make one",
  "make one for me",
  "i want this for my business",
  "i need this for my business",
  "i want to get started",
  "how can i get started",
  "let's do it",
  "lets do it",
  "i want to work with you",
  "i want to talk to him",
  "i need your service",
  "i want your service",
  "how much will it cost",
  "what will it cost",
  "how much is it",
  "i want to order one"
];

function detectInterest(text) {
  const lower = String(text || "").toLowerCase();

  return INTEREST_PATTERNS.some((pattern) =>
    lower.includes(pattern)
  );
}

/* ============================================================================
   UPDATE LEAD INFORMATION
============================================================================ */

function updateLeadInformation(chat, text) {
  const lower = String(text || "").toLowerCase();

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
    "hospital",
    "church",
    "company",
    "business",
    "clothing",
    "fashion",
    "delivery",
    "logistics"
  ];

  const requirements = [
    "ordering bot",
    "order bot",
    "whatsapp bot",
    "ai bot",
    "customer service",
    "booking bot",
    "booking system",
    "ordering system",
    "payment bot",
    "delivery bot",
    "restaurant bot",
    "chatbot"
  ];

  for (const type of businessTypes) {
    if (lower.includes(type)) {
      chat.lead.businessType = type;
      break;
    }
  }

  for (const requirement of requirements) {
    if (lower.includes(requirement)) {
      chat.lead.needs = requirement;
      break;
    }
  }

  if (
    lower.includes("my name is ") ||
    lower.includes("i am ") ||
    lower.includes("i'm ")
  ) {
    const match = String(text).match(
      /(?:my name is|i am|i'm)\s+([A-Za-z][A-Za-z\s'-]{1,40})/i
    );

    if (match) {
      chat.lead.name = match[1].trim();
    }
  }
}

/* ============================================================================
   EXTRACT WHATSAPP MESSAGE TEXT
============================================================================ */

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

  if (message.ephemeralMessage?.message) {
    return extractMessageText(message.ephemeralMessage.message);
  }

  if (message.viewOnceMessage?.message) {
    return extractMessageText(message.viewOnceMessage.message);
  }

  if (message.viewOnceMessageV2?.message) {
    return extractMessageText(message.viewOnceMessageV2.message);
  }

  if (message.viewOnceMessageV2Extension?.message) {
    return extractMessageText(message.viewOnceMessageV2Extension.message);
  }

  if (message.documentWithCaptionMessage?.message) {
    return extractMessageText(
      message.documentWithCaptionMessage.message
    );
  }

  return "";
}

/* ============================================================================
   AI
============================================================================ */

async function askAI(messages) {
  const recentMessages = messages.slice(-12);

  const conversationText = recentMessages
    .map((m) => {
      const role = m.role === "assistant" ? "Assistant" : "Customer";

      return `${role}: ${m.text}`;
    })
    .join("\n");

  const prompt = `
${BUSINESS_RULES}

Conversation:

${conversationText}

Reply naturally to the customer's latest message.

Keep the response suitable for WhatsApp.
`;

  /* ------------------------------------------------------------------------
     GEMINI
  ------------------------------------------------------------------------ */

  if (gemini) {
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await gemini.models.generateContent({
          model: GEMINI_MODEL,
          contents: prompt
        });

        const text =
          response?.text ||
          response?.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || "")
            .join("") ||
          "";

        if (text.trim()) {
          return text.trim();
        }

      } catch (error) {
        lastError = error;

        const status =
          error?.status ||
          error?.response?.status ||
          error?.code;

        console.log(
          `⚠️ Gemini attempt ${attempt} failed:`,
          error?.message || error
        );

        if (status !== 503 && status !== 429) {
          break;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, attempt * 2000)
        );
      }
    }

    console.log(
      "⚠️ Gemini failed completely:",
      lastError?.message || ""
    );
  }

  /* ------------------------------------------------------------------------
     GROQ FALLBACK
  ------------------------------------------------------------------------ */

  if (groq) {
    try {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL,

        temperature: 0.7,

        messages: [
          {
            role: "system",
            content: BUSINESS_RULES
          },
          {
            role: "user",
            content: conversationText
          }
        ]
      });

      const result =
        completion?.choices?.[0]?.message?.content || "";

      if (result.trim()) {
        return result.trim();
      }

    } catch (error) {
      console.log(
        "❌ Groq fallback failed:",
        error?.message || error
      );
    }
  }

  return "Thanks for your message. I'll get back to you shortly. 👍";
}

/* ============================================================================
   META WHATSAPP SEND
============================================================================ */

async function sendBotMessage(to, body) {
  if (
    !WHATSAPP_ACCESS_TOKEN ||
    !WHATSAPP_PHONE_NUMBER_ID
  ) {
    console.log(
      "❌ Meta WhatsApp credentials are missing."
    );

    return null;
  }

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v23.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,

      {
        messaging_product: "whatsapp",

        to: normalizePhone(to),

        type: "text",

        text: {
          body: String(body)
        }
      },

      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,

          "Content-Type": "application/json"
        }
      }
    );

    return response.data;

  } catch (error) {
    console.log(
      "❌ Meta WhatsApp send error:",
      error?.response?.data || error?.message || error
    );

    return null;
  }
}

/* ============================================================================
   BAILEYS SEND
============================================================================ */

async function sendBaileysMessage(
  sessionKey,
  sock,
  jid,
  text
) {
  try {
    /*
      Remember this message before sending so the Baileys fromMe event
      will not be mistaken for a manual owner reply.
    */

    rememberBotMessage(
      sessionKey,
      jid,
      text
    );

    const result = await sock.sendMessage(
      jid,
      {
        text: String(text)
      }
    );

    return result;

  } catch (error) {
    console.log(
      `❌ Failed to send Baileys message (${sessionKey}):`,
      error?.message || error
    );

    return null;
  }
}

/* ============================================================================
   NOTIFY OWNER
============================================================================ */

async function notifyOwner(
  from,
  userText,
  conversation,
  sourceLabel
) {
  if (conversation.notifiedOwner) {
    return;
  }

  conversation.notifiedOwner = true;

  const lead = conversation.lead || {};

  const message = `
🔔 STONY_TECH LEAD

Source: ${sourceLabel}
Customer: +${from}

Message:
${userText}

Business Type:
${lead.businessType || "Not provided"}

Need:
${lead.needs || "Not provided"}

Name:
${lead.name || "Not provided"}

Please follow up with the customer.
`;

  await sendBotMessage(
    OWNER_NUMBER,
    message.trim()
  );

  console.log(
    `📢 Owner notified about +${from} (${sourceLabel})`
  );
}

/* ============================================================================
   FALLBACK TIMER
============================================================================ */

function startFallbackTimer(
  sessionKey,
  sock,
  from,
  chat
) {
  if (chat.fallbackTimer) {
    clearTimeout(chat.fallbackTimer);
    chat.fallbackTimer = null;
  }

  console.log(
    `⏱️ Starting 1-minute fallback timer for +${from} (${sessionKey})...`
  );

  chat.fallbackTimer = setTimeout(
    async () => {
      chat.fallbackTimer = null;

      /*
        SAFETY CHECK #1:
        Check the blocked list again when the timer expires.
      */

      if (
        isBlockedForSession(
          sessionKey,
          from
        )
      ) {
        console.log(
          `🚫 Timer stopped because +${from} (${sessionKey}) is blocked.`
        );

        return;
      }

      /*
        SAFETY CHECK #2:
        Owner may have replied manually.
      */

      if (chat.ownerReplied) {
        console.log(
          `👤 Owner already replied to +${from}. Bot will not take over.`
        );

        return;
      }

      console.log(
        `⏰ 1-minute timer expired for +${from} (${sessionKey}).`
      );

      chat.botActive = true;

      console.log(
        `🤖 Baileys bot is taking over the conversation with +${from}.`
      );

      const unavailableMsg =
        "Hi 👋 I'm Stony_Tech's assistant. The owner is currently unavailable, but I can help you here. What would you like to know?";

      chat.messages.push({
        role: "assistant",
        text: unavailableMsg
      });

      await sendBaileysMessage(
        sessionKey,
        sock,
        `${normalizePhone(from)}@s.whatsapp.net`,
        unavailableMsg
      );

      /*
        Generate AI response.
      */

      try {
        const aiReply = await askAI(
          chat.messages
        );

        chat.messages.push({
          role: "assistant",
          text: aiReply
        });

        await sendBaileysMessage(
          sessionKey,
          sock,
          `${normalizePhone(from)}@s.whatsapp.net`,
          aiReply
        );

        console.log(
          `🤖 Baileys AI replied to +${from} (${sessionKey}).`
        );

      } catch (error) {
        console.log(
          `❌ Baileys AI error for +${from}:`,
          error?.message || error
        );
      }
    },

    FALLBACK_DELAY_MS
  );
}

/* ============================================================================
   START BAILEYS CLIENT
============================================================================ */

async function startBaileysClient(
  sessionKey,
  phone,
  authFolder,
  blockedList
) {
  try {
    console.log("");
    console.log(
      `==================================================`
    );
    console.log(
      `Starting Baileys session: ${sessionKey}`
    );
    console.log(
      `Phone: +${phone}`
    );
    console.log(
      `==================================================`
    );

    const { state, saveCreds } =
      await useMultiFileAuthState(authFolder);

    let version;

    try {
      const latest =
        await fetchLatestBaileysVersion();

      version = latest.version;

      console.log(
        `📱 Baileys version: ${version.join(".")}`
      );

    } catch (error) {
      console.log(
        "⚠️ Could not fetch latest Baileys version."
      );
    }

    const sock = makeWASocket({
      auth: state,

      ...(version ? { version } : {}),

      printQRInTerminal: false,

      logger: pino({
        level: "silent"
      }),

      browser: [
        "Stony_Tech",
        "Chrome",
        "1.0.0"
      ],

      generateHighQualityLinkPreview: false,

      syncFullHistory: false
    });

    /* ------------------------------------------------------------------------
       SAVE CREDENTIALS
    ------------------------------------------------------------------------ */

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    /* ------------------------------------------------------------------------
       CONNECTION UPDATE
    ------------------------------------------------------------------------ */

    sock.ev.on(
      "connection.update",
      async (update) => {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        if (qr) {
          console.log("");
          console.log(
            `📲 Scan this QR code for ${sessionKey}:`
          );

          qrcode.generate(
            qr,
            {
              small: true
            }
          );
        }

        if (connection === "open") {
          console.log("");
          console.log(
            `✅ ${sessionKey.toUpperCase()} WhatsApp connected successfully.`
          );

          console.log(
            `📱 Number: +${phone}`
          );

          console.log(
            `🚫 Blocked numbers for ${sessionKey}:`,
            BLOCKED_NUMBERS[sessionKey]
          );
        }

        if (connection === "close") {
          const statusCode =
            new Boom(
              lastDisconnect?.error
            )?.output?.statusCode;

          const shouldReconnect =
            statusCode !==
            DisconnectReason.loggedOut;

          console.log("");
          console.log(
            `❌ ${sessionKey} WhatsApp connection closed.`
          );

          console.log(
            `Status code: ${statusCode}`
          );

          if (shouldReconnect) {
            console.log(
              `🔄 Reconnecting ${sessionKey}...`
            );

            setTimeout(() => {
              startBaileysClient(
                sessionKey,
                phone,
                authFolder,
                blockedList
              );
            }, 5000);

          } else {
            console.log(
              `🚪 ${sessionKey} logged out.`
            );
          }
        }
      }
    );

    /* ------------------------------------------------------------------------
       INCOMING / OUTGOING MESSAGES
    ------------------------------------------------------------------------ */

    sock.ev.on(
      "messages.upsert",
      async ({ messages }) => {
        for (const msg of messages) {
          try {
            if (!msg?.message) {
              continue;
            }

            const remoteJid =
              msg.key?.remoteJid || "";

            /*
              Ignore:
              - status broadcasts
              - group messages
            */

            if (
              !remoteJid ||
              remoteJid === "status@broadcast" ||
              remoteJid.endsWith("@g.us")
            ) {
              continue;
            }

            const from =
              normalizePhone(
                remoteJid.split("@")[0]
              );

            if (!from) {
              continue;
            }

            const text =
              extractMessageText(
                msg.message
              ).trim();

            if (!text) {
              continue;
            }

            /* ================================================================
               FROM ME
            ================================================================= */

            if (msg.key?.fromMe) {
              /*
                Check whether this was generated by our bot.
              */

              const wasBotMessage =
                isRecentBotMessage(
                  sessionKey,
                  remoteJid,
                  text
                );

              if (wasBotMessage) {
                /*
                  IMPORTANT:
                  Do NOT treat bot-generated outgoing messages as
                  manual owner replies.

                  Also do NOT print the entire welcome/AI message.
                */

                console.log(
                  `🤖 Bot outgoing message sent to +${from} (${sessionKey}).`
                );

                continue;
              }

              /*
                Otherwise this is a real manual message from the owner.
              */

              const chat =
                getPersonalChat(
                  sessionKey,
                  from
                );

              chat.ownerReplied = true;
              chat.botActive = false;

              if (chat.fallbackTimer) {
                clearTimeout(
                  chat.fallbackTimer
                );

                chat.fallbackTimer = null;
              }

              chat.messages.push({
                role: "assistant",
                text
              });

              console.log(
                `📤 Owner/manual reply to +${from} (${sessionKey}).`
              );

              console.log(
                `👤 Owner replied. 1-minute timer cleared for +${from}.`
              );

              continue;
            }

            /* ================================================================
               CUSTOMER MESSAGE
            ================================================================= */

            console.log(
              `📩 Incoming message from +${from} (${sessionKey === "main" ? "Main personal number" : "Second personal number"}): "${text}"`
            );

            /* ================================================================
               BLOCK CHECK
            ================================================================= */

            if (
              isBlockedForSession(
                sessionKey,
                from
              )
            ) {
              console.log(
                `🚫 BLOCKED NUMBER: +${from} (${sessionKey === "main" ? "Main personal number" : "Second personal number"})`
              );

              console.log(
                `🚫 Action: Message ignored. No timer, no AI, no reply.`
              );

              /*
                VERY IMPORTANT:
                Do not create/get the chat.
                Do not notify owner.
                Do not start timer.
                Do not call AI.
              */

              continue;
            }

            /* ================================================================
               NORMAL CUSTOMER
            ================================================================= */

            const chat =
              getPersonalChat(
                sessionKey,
                from
              );

            /*
              New incoming message means owner has not manually replied
              to this latest message.
            */

            chat.ownerReplied = false;

            chat.messages.push({
              role: "user",
              text
            });

            updateLeadInformation(
              chat,
              text
            );

            /* ================================================================
               INTEREST
            ================================================================= */

            if (
              detectInterest(text) &&
              !chat.notifiedOwner
            ) {
              await notifyOwner(
                from,
                text,
                chat,
                sessionKey === "main"
                  ? "Main personal number"
                  : "Second personal number"
              );
            }

            /* ================================================================
               BOT ALREADY ACTIVE
            ================================================================= */

            if (chat.botActive) {
              try {
                const reply =
                  await askAI(
                    chat.messages
                  );

                chat.messages.push({
                  role: "assistant",
                  text: reply
                });

                await sendBaileysMessage(
                  sessionKey,
                  sock,
                  remoteJid,
                  reply
                );

                console.log(
                  `🤖 Baileys bot replied to +${from} (${sessionKey}).`
                );

              } catch (error) {
                console.log(
                  `❌ AI reply failed for +${from}:`,
                  error?.message || error
                );
              }

              continue;
            }

            /* ================================================================
               START 1-MINUTE OWNER TIMER
            ================================================================= */

            startFallbackTimer(
              sessionKey,
              sock,
              from,
              chat
            );

          } catch (error) {
            console.log(
              `❌ Error processing ${sessionKey} message:`,
              error?.message || error
            );
          }
        }
      }
    );

    return sock;

  } catch (error) {
    console.log(
      `❌ Failed to start ${sessionKey} Baileys client:`,
      error?.message || error
    );

    setTimeout(() => {
      startBaileysClient(
        sessionKey,
        phone,
        authFolder,
        blockedList
      );
    }, 10000);
  }
}

/* ============================================================================
   META WEBHOOK
============================================================================ */

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

/* ============================================================================
   META WEBHOOK POST
============================================================================ */

app.post(
  "/webhook",
  async (req, res) => {
    /*
      Respond immediately to Meta.
    */

    res.sendStatus(200);

    try {
      const entries =
        req.body?.entry || [];

      for (const entry of entries) {
        const changes =
          entry?.changes || [];

        for (const change of changes) {
          const value =
            change?.value;

          const messages =
            value?.messages || [];

          for (const message of messages) {
            const from =
              normalizePhone(
                message?.from
              );

            if (!from) {
              continue;
            }

            let text = "";

            if (
              message.type === "text"
            ) {
              text =
                message.text?.body || "";
            }

            text = String(text).trim();

            if (!text) {
              continue;
            }

            /* ================================================================
               META INCOMING LOG
            ================================================================= */

            console.log(
              `📩 Incoming message from +${from} (Meta Bot): "${text}"`
            );

            const chat =
              getMetaChat(from);

            chat.messages.push({
              role: "user",
              text
            });

            updateLeadInformation(
              chat,
              text
            );

            /* ================================================================
               INTEREST
            ================================================================= */

            if (
              detectInterest(text) &&
              !chat.notifiedOwner
            ) {
              await notifyOwner(
                from,
                text,
                chat,
                "Meta Bot"
              );
            }

            /* ================================================================
               AI RESPONSE
            ================================================================= */

            const reply =
              await askAI(
                chat.messages
              );

            chat.messages.push({
              role: "assistant",
              text: reply
            });

            await sendBotMessage(
              from,
              reply
            );

            /*
              Do not log the full AI/welcome message as an incoming message.
            */

            console.log(
              `🤖 Meta bot replied to +${from}.`
            );
          }
        }
      }

    } catch (error) {
      console.log(
        "❌ Meta webhook processing error:",
        error?.response?.data ||
        error?.message ||
        error
      );
    }
  }
);

/* ============================================================================
   HOME
============================================================================ */

app.get(
  "/",
  (req, res) => {
    res.send(`
      <html>
        <head>
          <title>Stony_Tech WhatsApp AI</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>

        <body style="
          font-family:Arial;
          padding:30px;
          background:#111;
          color:#fff;
        ">

          <h1>Stony_Tech WhatsApp AI</h1>

          <p>WhatsApp AI assistant is running.</p>

          <p>
            <a
              href="/health"
              style="color:#4ade80"
            >
              Health
            </a>
          </p>

          <p>
            <a
              href="/blocked"
              style="color:#60a5fa"
            >
              Blocked Numbers
            </a>
          </p>

        </body>
      </html>
    `);
  }
);

/* ============================================================================
   HEALTH
============================================================================ */

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",

      service: "Stony_Tech WhatsApp AI",

      time: new Date().toISOString(),

      owner: OWNER_NUMBER,

      fallbackDelay: FALLBACK_DELAY_MS,

      sessions: {
        main: {
          phone: MAIN_BAILEYS_PHONE,
          blocked: BLOCKED_NUMBERS.main
        },

        second: {
          phone: SECOND_BAILEYS_PHONE,
          blocked: BLOCKED_NUMBERS.second
        }
      },

      meta: {
        configured:
          !!(
            WHATSAPP_ACCESS_TOKEN &&
            WHATSAPP_PHONE_NUMBER_ID
          )
      },

      ai: {
        gemini:
          !!GEMINI_API_KEY,

        groq:
          !!GROQ_API_KEY
      }
    });
  }
);

/* ============================================================================
   BLOCKED NUMBERS PAGE
============================================================================ */

app.get(
  "/blocked",
  (req, res) => {
    res.json({
      main: {
        phone: MAIN_BAILEYS_PHONE,

        blockedNumbers:
          BLOCKED_NUMBERS.main
      },

      second: {
        phone: SECOND_BAILEYS_PHONE,

        blockedNumbers:
          BLOCKED_NUMBERS.second
      },

      rule:
        "Blocked numbers receive no AI reply, no fallback timer and no owner notification."
    });
  }
);

/* ============================================================================
   START SERVER
============================================================================ */

app.listen(
  PORT,
  () => {
    console.log("");
    console.log(
      "=================================================="
    );

    console.log(
      "🚀 Stony_Tech WhatsApp AI Server Started"
    );

    console.log(
      `🌐 Port: ${PORT}`
    );

    console.log(
      "=================================================="
    );

    console.log(
      `📱 Main personal number: +${MAIN_BAILEYS_PHONE}`
    );

    console.log(
      `📱 Second personal number: +${SECOND_BAILEYS_PHONE}`
    );

    console.log(
      `🤖 Meta bot configured: ${
        !!WHATSAPP_ACCESS_TOKEN
      }`
    );

    console.log(
      `🧠 Gemini configured: ${
        !!GEMINI_API_KEY
      }`
    );

    console.log(
      `🧠 Groq configured: ${
        !!GROQ_API_KEY
      }`
    );

    console.log(
      `⏱️ Fallback delay: ${
        FALLBACK_DELAY_MS / 1000
      } seconds`
    );

    console.log("");
    console.log(
      "🚫 Main blocked numbers:"
    );

    console.log(
      BLOCKED_NUMBERS.main
        .map((n) => `+${n}`)
        .join(", ")
    );

    console.log("");
    console.log(
      "🚫 Second blocked numbers:"
    );

    console.log(
      BLOCKED_NUMBERS.second
        .map((n) => `+${n}`)
        .join(", ")
    );

    console.log(
      "=================================================="
    );

    /*
      Start both personal WhatsApp accounts.
    */

    startBaileysClient(
      "main",
      MAIN_BAILEYS_PHONE,
      AUTH_FOLDER_MAIN,
      BLOCKED_NUMBERS.main
    );

    startBaileysClient(
      "second",
      SECOND_BAILEYS_PHONE,
      AUTH_FOLDER_SEC,
      BLOCKED_NUMBERS.second
    );
  }
);
