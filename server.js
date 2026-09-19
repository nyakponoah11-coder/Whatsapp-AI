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

const { Boom } = require("@hapi/boom");
const fs = require("fs");

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

if (!GEMINI_API_KEY)
  console.warn("⚠️ Missing GEMINI_API_KEY");

if (!GROQ_API_KEY)
  console.warn("⚠️ Missing GROQ_API_KEY");

if (!WHATSAPP_ACCESS_TOKEN)
  console.warn("⚠️ Missing WHATSAPP_ACCESS_TOKEN");

if (!WHATSAPP_PHONE_NUMBER_ID)
  console.warn("⚠️ Missing WHATSAPP_PHONE_NUMBER_ID");

if (!WHATSAPP_VERIFY_TOKEN)
  console.warn("⚠️ Missing WHATSAPP_VERIFY_TOKEN");

// ============================================================
// AI
// ============================================================

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

const groq = new Groq({
  apiKey: GROQ_API_KEY
});

// ============================================================
// CONFIG
// ============================================================

const OWNER_NUMBER = "233547100951";

const FALLBACK_DELAY_MS = 1 * 60 * 1000;

const AUTH_FOLDER_MAIN = "./baileys_auth";
const AUTH_FOLDER_SEC = "./baileys_auth_second";

// ============================================================
// BLOCKED NUMBERS
//
// IMPORTANT:
// Each WhatsApp account has its OWN blocked list.
//
// main   = blocked from main WhatsApp number
// second = blocked from second WhatsApp number
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
// NORMALIZE PHONE NUMBER
// ============================================================

function normalizePhone(number) {
  if (!number) return "";

  return String(number).replace(/\D/g, "");
}

// ============================================================
// CHECK BLOCKED NUMBER FOR SPECIFIC SESSION
//
// This is the important fix.
//
// We DO NOT use one global blocked list anymore.
// ============================================================

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
// BOT NUMBER CONVERSATIONS
// ============================================================

const botConversations = new Map();

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
// PERSONAL / SECONDARY NUMBER CONVERSATIONS
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

      lead: {
        name: null,
        business: null,
        businessType: null,
        requirement: null,
        notifiedOwner: false
      }
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

  return patterns.some((p) => msg.includes(p));
}

// ============================================================
// LEAD INFORMATION
// ============================================================

function updateLeadInformation(conversation, text) {
  const lower = text.toLowerCase();

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

  for (const type of businessTypes) {
    if (lower.includes(type)) {
      conversation.lead.businessType = type;
      break;
    }
  }

  const requirementPatterns = [
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

  for (const req of requirementPatterns) {
    if (lower.includes(req)) {
      conversation.lead.requirement = text;
      break;
    }
  }
}

// ============================================================
// ROBUST MESSAGE TEXT EXTRACTOR
// ============================================================

function extractMessageText(msgObj) {
  if (!msgObj) return "";

  if (msgObj.conversation) {
    return msgObj.conversation;
  }

  if (msgObj.extendedTextMessage?.text) {
    return msgObj.extendedTextMessage.text;
  }

  if (msgObj.imageMessage?.caption) {
    return msgObj.imageMessage.caption;
  }

  if (msgObj.videoMessage?.caption) {
    return msgObj.videoMessage.caption;
  }

  const innerKeys = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "documentWithCaptionMessage"
  ];

  for (const key of innerKeys) {
    if (msgObj[key]?.message) {
      const extracted = extractMessageText(
        msgObj[key].message
      );

      if (extracted) return extracted;
    }
  }

  return "";
}

// ============================================================
// AI ENGINE
// GEMINI -> GROQ FALLBACK
// ============================================================

async function askAI(messages) {
  const history = messages
    .slice(-12)
    .map((m) => `${m.role}: ${m.text}`)
    .join("\n");

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

  const model =
    process.env.GEMINI_MODEL || "gemini-2.5-flash";

  // ==========================================================
  // GEMINI
  // ==========================================================

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result =
        await ai.models.generateContent({
          model,
          contents: prompt
        });

      const reply = result.text?.trim();

      if (reply) {
        return reply;
      }

      throw new Error(
        "Gemini returned empty response."
      );

    } catch (error) {
      const status =
        error?.status ||
        error?.response?.status;

      if (status === 503 || status === 429) {
        if (attempt < 3) {
          await new Promise((resolve) =>
            setTimeout(resolve, attempt * 2000)
          );

          continue;
        }
      } else {
        break;
      }
    }
  }

  // ==========================================================
  // GROQ FALLBACK
  // ==========================================================

  try {
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

        model: "llama3-70b-8192",

        temperature: 0.7
      });

    const groqReply =
      chatCompletion.choices[0]
        ?.message
        ?.content
        ?.trim();

    if (groqReply) {
      return groqReply;
    }

    throw new Error(
      "Groq returned empty response."
    );

  } catch (groqError) {
    throw new Error(
      "Both AI engines failed."
    );
  }
}

// ============================================================
// NOTIFY OWNER VIA META API
// ============================================================

async function notifyOwner(
  from,
  userText,
  conversation,
  sourceLabel = "Meta Bot"
) {
  if (conversation.notifiedOwner) return;

  const lead = conversation.lead;

  const msg = `
🚨 NEW POTENTIAL CLIENT (${sourceLabel})

📱 Customer: +${from}

🏢 Business:
${lead.business || "Not provided"}

💼 Business Type:
${lead.businessType || "Not provided"}

🤖 Bot Needed:
${lead.requirement || "Not fully identified"}

💬 Message:
"${userText}"

🔥 Interest: HIGH

👉 Please follow up with this customer.
`.trim();

  try {
    await sendBotMessage(
      OWNER_NUMBER,
      msg
    );

    conversation.notifiedOwner = true;

  } catch (err) {
    console.error(
      "Owner notification failed:",
      err?.message
    );
  }
}

// ============================================================
// SEND MESSAGE VIA META API
// ============================================================

async function sendBotMessage(to, body) {
  const url =
    `https://graph.facebook.com/v23.0/` +
    `${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const res = await axios.post(
    url,

    {
      messaging_product: "whatsapp",

      recipient_type: "individual",

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

  return res.data;
}

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
// START BAILEYS CLIENT
// ============================================================

async function startBaileysClient(
  sessionKey,
  phoneNumber,
  authFolder
) {
  try {
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

    const {
      version
    } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,

      auth: state,

      printQRInTerminal: false,

      logger: require("pino")({
        level: "silent"
      }),

      browser: [
        `Stony_Tech Bot (${phoneNumber})`,
        "Chrome",
        "1.0.0"
      ],

      syncFullHistory: true,

      markOnlineOnConnect: true,

      getMessage: async () => ({
        conversation: "Hello"
      })
    });

    baileysSessions[sessionKey].sock =
      sock;

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    // ========================================================
    // CONNECTION UPDATE
    // ========================================================

    sock.ev.on(
      "connection.update",
      (update) => {
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
            `📱 QR generated for ${sessionKey}`
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
            `✅ Baileys [${sessionKey.toUpperCase()} - +${phoneNumber}] connected successfully!`
          );
        }

        if (connection === "close") {
          baileysSessions[
            sessionKey
          ].connected = false;

          const statusCode =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;

          const shouldReconnect =
            statusCode !==
            DisconnectReason.loggedOut;

          console.log(
            `❌ Baileys [${sessionKey}] disconnected.`
          );

          if (shouldReconnect) {
            console.log(
              `🔄 Reconnecting ${sessionKey} in 5 seconds...`
            );

            setTimeout(() => {
              startBaileysClient(
                sessionKey,
                phoneNumber,
                authFolder
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

    // ========================================================
    // INCOMING MESSAGES
    // ========================================================

    sock.ev.on(
      "messages.upsert",
      async ({ messages }) => {

        for (const msg of messages) {

          try {

            const jid =
              msg.key?.remoteJid;

            // Ignore invalid messages
            if (!jid) continue;

            // Ignore status
            if (
              jid === "status@broadcast"
            ) {
              continue;
            }

            // Ignore groups
            if (jid.includes("@g.us")) {
              continue;
            }

            // Only individual chats
            if (
              !jid.endsWith(
                "@s.whatsapp.net"
              )
            ) {
              continue;
            }

            const fromMe =
              msg.key.fromMe;

            const from =
              jid.replace(
                "@s.whatsapp.net",
                ""
              );

            const label =
              sessionKey === "main"
                ? "Main personal number"
                : "Secondary personal number";

            const text =
              extractMessageText(
                msg.message
              );

            if (!text.trim()) {
              continue;
            }

            // ==================================================
            // BLOCKED NUMBER CHECK
            //
            // THIS MUST HAPPEN BEFORE ANY BOT LOGIC.
            // ==================================================

            if (
              isBlockedForSession(
                sessionKey,
                from
              )
            ) {

              console.log(
                `🚫 BLOCKED MESSAGE`
              );

              console.log(
                `Number: +${from}`
              );

              console.log(
                `Account: ${label}`
              );

              console.log(
                `Action: NO REPLY / NO TIMER / NO AI`
              );

              // VERY IMPORTANT:
              // Do not create a chat.
              // Do not start timer.
              // Do not call AI.
              // Do not notify owner.
              // Do not reply.

              continue;
            }

            // ==================================================
            // OWNER MANUALLY REPLIED
            // ==================================================

            if (fromMe) {

              const chat =
                getPersonalChat(from);

              chat.ownerReplied = true;

              chat.botActive = false;

              if (chat.fallbackTimer) {

                clearTimeout(
                  chat.fallbackTimer
                );

                chat.fallbackTimer =
                  null;
              }

              chat.messages.push({
                role: "assistant",
                text: text.trim()
              });

              console.log(
                `👤 Owner reply from +${from} on ${label}`
              );

              console.log(
                `⏹️ Bot timer cleared.`
              );

              continue;
            }

            // ==================================================
            // UNBLOCKED MESSAGE
            // ==================================================

            console.log(
              `📩 Incoming message from +${from} on ${label}: "${text.trim()}"`
            );

            const chat =
              getPersonalChat(from);

            chat.messages.push({
              role: "customer",
              text: text.trim()
            });

            chat.lastCustomerMessage =
              text.trim();

            updateLeadInformation(
              chat,
              text.trim()
            );

            // ==================================================
            // INTEREST DETECTION
            // ==================================================

            if (
              detectInterest(
                text.trim()
              )
            ) {

              await notifyOwner(
                from,
                text.trim(),
                chat,
                label
              );
            }

            // ==================================================
            // BOT ALREADY ACTIVE
            // ==================================================

            if (chat.botActive) {

              // SAFETY CHECK
              if (
                isBlockedForSession(
                  sessionKey,
                  from
                )
              ) {
                console.log(
                  `🚫 +${from} became blocked. No AI reply.`
                );

                continue;
              }

              let reply;

              try {
                reply =
                  await askAI(
                    chat.messages
                  );
              } catch {
                reply =
                  "Sorry, I'm having a little trouble right now. Please try again shortly. 🙏";
              }

              // SAFETY CHECK AGAIN
              if (
                isBlockedForSession(
                  sessionKey,
                  from
                )
              ) {
                console.log(
                  `🚫 +${from} blocked before AI message was sent.`
                );

                continue;
              }

              chat.messages.push({
                role: "assistant",
                text: reply
              });

              if (
                chat.messages.length > 20
              ) {
                chat.messages =
                  chat.messages.slice(-20);
              }

              await sock.sendMessage(
                jid,
                {
                  text: reply
                }
              );

              console.log(
                `🤖 Bot replied to +${from} on ${label}: "${reply}"`
              );

              continue;
            }

            // ==================================================
            // START FALLBACK TIMER
            // ==================================================

            console.log(
              `⏱️ Starting 1-minute fallback timer for +${from} on ${label}...`
            );

            startFallbackTimer(
              from,
              jid,
              chat,
              sock,
              label,
              sessionKey
            );

          } catch (err) {

            console.error(
              `❌ Message handler error on Baileys [${sessionKey}]:`,
              err?.message
            );
          }
        }
      }
    );

  } catch (error) {

    console.error(
      `❌ Failed to start Baileys [${sessionKey}]:`,
      error?.message
    );

    setTimeout(() => {
      startBaileysClient(
        sessionKey,
        phoneNumber,
        authFolder
      );
    }, 5000);
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

  if (
    chat.fallbackTimer ||
    chat.botActive
  ) {
    return;
  }

  chat.ownerReplied = false;

  chat.fallbackTimer =
    setTimeout(
      async () => {

        chat.fallbackTimer = null;

        // ======================================================
        // SAFETY CHECK #1
        // ======================================================

        if (
          isBlockedForSession(
            sessionKey,
            from
          )
        ) {

          console.log(
            `🚫 TIMER CANCELLED`
          );

          console.log(
            `+${from} is blocked on ${label}.`
          );

          return;
        }

        // ======================================================
        // OWNER DID NOT REPLY
        // ======================================================

        if (
          !chat.ownerReplied &&
          activeSock
        ) {

          console.log(
            `⏰ Timer expired after 1 minute.`
          );

          console.log(
            `Bot taking over +${from} on ${label}.`
          );

          chat.botActive = true;

          const unavailableMsg =
            "Hi! 👋 Stony is not currently available, but I'm the assistant and I'm here to help you.\n\nHow can I assist you please?";

          try {

            // ==================================================
            // SAFETY CHECK #2
            // ==================================================

            if (
              isBlockedForSession(
                sessionKey,
                from
              )
            ) {

              console.log(
                `🚫 BLOCKED BEFORE FALLBACK MESSAGE`
              );

              chat.botActive = false;

              return;
            }

            // ==================================================
            // SEND FALLBACK MESSAGE
            // ==================================================

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
              `🤖 Fallback message sent to +${from}`
            );

            // ==================================================
            // AI REPLY TO LAST CUSTOMER MESSAGE
            // ==================================================

            if (
              chat.lastCustomerMessage
            ) {

              // SAFETY CHECK #3
              if (
                isBlockedForSession(
                  sessionKey,
                  from
                )
              ) {

                console.log(
                  `🚫 BLOCKED BEFORE AI GENERATION`
                );

                chat.botActive = false;

                return;
              }

              let aiReply;

              try {

                aiReply =
                  await askAI(
                    chat.messages
                  );

              } catch {

                aiReply =
                  "I'm here to help! Could you tell me about your business and what you need? 😊";
              }

              // SAFETY CHECK #4
              if (
                isBlockedForSession(
                  sessionKey,
                  from
                )
              ) {

                console.log(
                  `🚫 BLOCKED BEFORE AI SEND`
                );

                chat.botActive = false;

                return;
              }

              chat.messages.push({
                role: "assistant",
                text: aiReply
              });

              await activeSock.sendMessage(
                jid,
                {
                  text: aiReply
                }
              );

              console.log(
                `🤖 AI replied to +${from}: "${aiReply}"`
              );
            }

          } catch (err) {

            console.error(
              `❌ Fallback reply error for +${from}:`,
              err?.message
            );
          }
        }

      },

      FALLBACK_DELAY_MS
    );
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
      token === WHATSAPP_VERIFY_TOKEN
    ) {

      return res
        .status(200)
        .send(challenge);
    }

    return res.sendStatus(403);
  }
);

// ============================================================
// META BOT WEBHOOK
// ============================================================

app.post(
  "/webhook",
  async (req, res) => {

    // Immediately acknowledge Meta
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
        message.text
          ?.body
          ?.trim();

      if (
        !from ||
        !userText
      ) {
        return;
      }

      console.log(
        `📩 Incoming message from +${from} (Meta Bot)`
      );

      const conversation =
        getBotConversation(from);

      conversation.messages.push({
        role: "customer",
        text: userText
      });

      updateLeadInformation(
        conversation,
        userText
      );

      if (
        detectInterest(userText)
      ) {

        await notifyOwner(
          from,
          userText,
          conversation,
          "Meta Bot"
        );
      }

      let reply;

      try {

        reply =
          await askAI(
            conversation.messages
          );

      } catch {

        reply =
          "Sorry, I'm having a little trouble responding right now. Please try again in a moment. 🙏";
      }

      if (!reply) {

        reply =
          "Sorry, I couldn't generate a response right now. Please try again.";
      }

      conversation.messages.push({
        role: "assistant",
        text: reply
      });

      if (
        conversation.messages.length > 20
      ) {

        conversation.messages =
          conversation.messages.slice(-20);
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
        err?.message
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

    res.send(`
      <html>

        <head>
          <title>Blocked Numbers</title>

          <style>
            body {
              font-family: Arial, sans-serif;
              padding: 40px;
              background: #f4f4f9;
            }

            .card {
              background: white;
              padding: 25px;
              margin-bottom: 20px;
              border-radius: 12px;
              box-shadow: 0 4px 12px rgba(0,0,0,0.08);
            }

            h1 {
              margin-bottom: 30px;
            }

            h2 {
              margin-top: 0;
            }

            li {
              margin: 8px 0;
            }

            .main {
              border-left: 5px solid #2563eb;
            }

            .second {
              border-left: 5px solid #16a34a;
            }

            a {
              text-decoration: none;
              color: #2563eb;
            }
          </style>

        </head>

        <body>

          <h1>🚫 Blocked Numbers</h1>

          <div class="card main">

            <h2>
              Main Number
              (+${baileysSessions.main.phone})
            </h2>

            <ul>

              ${
                BLOCKED_NUMBERS.main
                  .map(
                    number =>
                      `<li>+${number}</li>`
                  )
                  .join("")
              }

            </ul>

          </div>

          <div class="card second">

            <h2>
              Second Number
              (+${baileysSessions.second.phone})
            </h2>

            <ul>

              ${
                BLOCKED_NUMBERS.second
                  .map(
                    number =>
                      `<li>+${number}</li>`
                  )
                  .join("")
              }

            </ul>

          </div>

          <p>
            <strong>
              🚫 Blocked numbers receive no automatic replies.
            </strong>
          </p>

          <br>

          <a href="/">
            ← Back to Dashboard
          </a>

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
            Scan WhatsApp QRs
          </title>

          <style>

            body {
              font-family: sans-serif;
              text-align: center;
              padding: 20px;
              background: #f4f4f9;
            }

            .card {
              background: white;
              padding: 20px;
              border-radius: 10px;
              box-shadow:
                0 4px 6px rgba(0,0,0,0.1);
              display: inline-block;
              margin: 15px;
              width: 320px;
              vertical-align: top;
              text-align: center;
            }

            img {
              border-radius: 10px;
              border: 1px solid #ddd;
              padding: 10px;
              background: white;
              width: 250px;
              height: 250px;
            }

            h2 {
              color: #333;
              margin-bottom: 5px;
            }

            p.status {
              font-weight: bold;
              margin-top: 15px;
            }

            a.back {
              display: block;
              margin-top: 20px;
              color: #007bff;
              text-decoration: none;
            }

          </style>

        </head>

        <body>

          <h1>
            📱 Connect Your Numbers
          </h1>

          <p>
            Open WhatsApp →
            Linked Devices →
            Link a Device →
            Scan
          </p>

          <div style="margin-top:20px;">
    `;

    // ========================================================
    // MAIN NUMBER
    // ========================================================

    html += `
      <div class="card">

        <h2>
          Main Number
        </h2>

        <p>
          +${baileysSessions.main.phone}
        </p>
    `;

    if (
      baileysSessions.main.connected
    ) {

      html += `
        <p
          class="status"
          style="color:green;"
        >
          ✅ Connected!
        </p>
      `;

    } else if (
      baileysSessions.main.qr
    ) {

      html += `
        <img
          src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(
            baileysSessions.main.qr
          )}"
        />
      `;

    } else {

      html += `
        <p
          class="status"
          style="color:#d97706;"
        >
          ⏳ Generating QR...
        </p>
      `;
    }

    html += `
      </div>
    `;

    // ========================================================
    // SECOND NUMBER
    // ========================================================

    html += `
      <div class="card">

        <h2>
          Second Number
        </h2>

        <p>
          +${baileysSessions.second.phone}
        </p>
    `;

    if (
      baileysSessions.second.connected
    ) {

      html += `
        <p
          class="status"
          style="color:green;"
        >
          ✅ Connected!
        </p>
      `;

    } else if (
      baileysSessions.second.qr
    ) {

      html += `
        <img
          src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(
            baileysSessions.second.qr
          )}"
        />
      `;

    } else {

      html += `
        <p
          class="status"
          style="color:#d97706;"
        >
          ⏳ Generating QR...
        </p>
      `;
    }

    html += `
      </div>

      </div>

      <a
        class="back"
        href="/"
      >
        ← Back to Dashboard
      </a>

      <script>
        setTimeout(
          () => {
            location.reload();
          },
          60000
        );
      </script>

      </body>
      </html>
    `;

    res.send(html);
  }
);

// ============================================================
// HOME DASHBOARD
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

          <style>

            body {
              font-family: Arial, sans-serif;
              padding: 40px;
              background: #f4f4f9;
            }

            .card {
              background: white;
              padding: 25px;
              border-radius: 12px;
              margin-bottom: 20px;
              box-shadow:
                0 4px 10px rgba(0,0,0,0.08);
            }

            a {
              color: #2563eb;
              text-decoration: none;
            }

          </style>

        </head>

        <body>

          <h2>
            🚀 Stony_Tech AI Bot
          </h2>

          <div class="card">

            <p>
              <strong>
                Main Number:
              </strong>

              +${baileysSessions.main.phone}

              ${
                baileysSessions.main.connected
                  ? "✅ Connected"
                  : "❌ Disconnected"
              }
            </p>

            <p>
              <strong>
                Second Number:
              </strong>

              +${baileysSessions.second.phone}

              ${
                baileysSessions.second.connected
                  ? "✅ Connected"
                  : "❌ Disconnected"
              }
            </p>

          </div>

          <div class="card">

            <p>
              <a href="/qr">
                📱 Scan QR Codes
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
      uptime: process.uptime(),

      sessions: {
        main:
          baileysSessions.main.connected,

        second:
          baileysSessions.second.connected
      },

      blocked: {
        main:
          BLOCKED_NUMBERS.main,

        second:
          BLOCKED_NUMBERS.second
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

    console.log(
      `🚀 Server running on port ${PORT}`
    );

    console.log(
      `🚫 Main blocked numbers:`,
      BLOCKED_NUMBERS.main
    );

    console.log(
      `🚫 Second blocked numbers:`,
      BLOCKED_NUMBERS.second
    );

    startBaileysClient(
      "main",
      baileysSessions.main.phone,
      AUTH_FOLDER_MAIN
    );

    startBaileysClient(
      "second",
      baileysSessions.second.phone,
      AUTH_FOLDER_SEC
    );
  }
);
