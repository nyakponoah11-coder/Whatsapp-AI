require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const {
  GEMINI_API_KEY,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN
} = process.env;

if (!GEMINI_API_KEY) console.warn("Missing GEMINI_API_KEY");
if (!WHATSAPP_ACCESS_TOKEN) console.warn("Missing WHATSAPP_ACCESS_TOKEN");
if (!WHATSAPP_PHONE_NUMBER_ID) console.warn("Missing WHATSAPP_PHONE_NUMBER_ID");
if (!WHATSAPP_VERIFY_TOKEN) console.warn("Missing WHATSAPP_VERIFY_TOKEN");

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

// ============================================================
// YOUR PERSONAL WHATSAPP NUMBER
// Ghana format: 0547100951 -> 233547100951
// ============================================================

const OWNER_WHATSAPP_NUMBER = "233547100951";

// ============================================================
// BUSINESS INFORMATION
// ============================================================

const BUSINESS_RULES = `
You are the AI business assistant for Stony_Tech.

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
- You are Stony_Tech's AI assistant.
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
// SIMPLE CONVERSATION MEMORY
// ============================================================

const conversations = new Map();

/*
Each customer gets:

{
  messages: [],
  notifiedOwner: false,
  lead: {
    name: null,
    business: null,
    businessType: null,
    requirement: null
  }
}
*/

function getConversation(phone) {
  if (!conversations.has(phone)) {
    conversations.set(phone, {
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

  return conversations.get(phone);
}


// ============================================================
// INTEREST DETECTION
// ============================================================

function detectInterest(text) {
  const message = text.toLowerCase().trim();

  const strongInterestPatterns = [
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
    "i want this for my restaurant",
    "i need this for my restaurant",
    "i want to get started",
    "how can i get started",
    "let's do it",
    "lets do it",
    "i want to work with you",
    "i need your service",
    "i want your service",
    "how much will it cost",
    "what will it cost",
    "how much is it",
    "i want to order one"
  ];

  return strongInterestPatterns.some(pattern =>
    message.includes(pattern)
  );
}


// ============================================================
// EXTRACT BASIC LEAD INFORMATION
// ============================================================

function updateLeadInformation(conversation, text) {
  const lower = text.toLowerCase();

  // Business type
  const businessTypes = [
    "restaurant",
    "food",
    "shop",
    "store",
    "school",
    "salon",
    "barber",
    "hotel",
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

  // Requirement
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

  for (const requirement of requirementPatterns) {
    if (lower.includes(requirement)) {
      conversation.lead.requirement = text;
      break;
    }
  }
}


// ============================================================
// GEMINI
// ============================================================

async function askGemini(conversation) {
  const history = conversation.messages
    .slice(-12)
    .map(item => `${item.role}: ${item.text}`)
    .join("\n");

  const prompt = `
BUSINESS RULES:
${BUSINESS_RULES}

CONVERSATION:
${history}

Respond to the customer based on the business rules.

Remember:
- Be natural.
- Keep the response reasonably short.
- Ask useful questions when more information is needed.
- Do not ask too many questions at once.
- Never invent pricing.
`.trim();

  const model =
    process.env.GEMINI_MODEL || "gemini-2.5-flash";

  let lastError;

  // Retry Gemini when it temporarily returns 503
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await ai.models.generateContent({
        model,
        contents: prompt
      });

      const reply = result.text?.trim();

      if (reply) {
        return reply;
      }

      throw new Error("Gemini returned an empty response.");

    } catch (error) {
      lastError = error;

      const status =
        error?.status ||
        error?.response?.status ||
        error?.code;

      console.error(
        `Gemini attempt ${attempt} failed:`,
        error?.message || error
      );

      if (status === 503 || status === 429) {
        await new Promise(resolve =>
          setTimeout(resolve, attempt * 2000)
        );
        continue;
      }

      break;
    }
  }

  throw lastError || new Error("Gemini request failed.");
}


// ============================================================
// NOTIFY NOAH
// ============================================================

async function notifyOwner(from, userText, conversation) {

  if (conversation.notifiedOwner) {
    return;
  }

  const lead = conversation.lead;

  const notification = `
🚨 NEW POTENTIAL CLIENT

📱 Customer:
+${from}

🏢 Business:
${lead.business || "Not provided"}

💼 Business Type:
${lead.businessType || "Not provided"}

🤖 Bot/System Needed:
${lead.requirement || "Not fully identified"}

💬 Latest Message:
"${userText}"

🔥 Interest:
HIGH

👉 Please follow up with this customer.
`.trim();

  try {
    await sendWhatsAppMessage(
      OWNER_WHATSAPP_NUMBER,
      notification
    );

    conversation.notifiedOwner = true;

    console.log(
      `Owner notified about potential client ${from}`
    );

  } catch (error) {
    console.error(
      "Failed to notify owner:",
      error?.response?.data ||
      error?.message ||
      error
    );
  }
}


// ============================================================
// META WEBHOOK VERIFICATION
// ============================================================

app.get("/webhook", (req, res) => {

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token === WHATSAPP_VERIFY_TOKEN
  ) {
    console.log("Webhook verified.");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});


// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
  res.status(200).send(
    "Noah WhatsApp AI Business Bot is running."
  );
});


// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    bot: "Noah WhatsApp AI Business Bot"
  });
});


// ============================================================
// INCOMING WHATSAPP MESSAGES
// ============================================================

app.post("/webhook", async (req, res) => {

  // Respond immediately to Meta
  res.sendStatus(200);

  try {

    const value =
      req.body?.entry?.[0]?.changes?.[0]?.value;

    const message =
      value?.messages?.[0];

    if (!message) return;

    // Only text messages
    if (message.type !== "text") {
      return;
    }

    const from = message.from;

    const userText =
      message.text?.body?.trim();

    if (!from || !userText) {
      return;
    }

    console.log(
      `Incoming message from ${from}: ${userText}`
    );

    const conversation =
      getConversation(from);

    // Save customer message
    conversation.messages.push({
      role: "customer",
      text: userText
    });

    // Update basic lead information
    updateLeadInformation(
      conversation,
      userText
    );

    // ========================================================
    // DETECT INTEREST
    // ========================================================

    const interested =
      detectInterest(userText);

    if (interested) {

      console.log(
        `🔥 Potential client detected: ${from}`
      );

      await notifyOwner(
        from,
        userText,
        conversation
      );
    }

    // ========================================================
    // ASK GEMINI
    // ========================================================

    let reply;

    try {

      reply = await askGemini(
        conversation
      );

    } catch (error) {

      console.error(
        "Gemini final error:",
        error?.message || error
      );

      reply =
        "Sorry, I'm having a little trouble responding right now. Please give me a moment and try again. 🙏";
    }

    if (!reply) {
      reply =
        "Sorry, I couldn't generate a response right now. Please try again.";
    }

    // Save bot reply
    conversation.messages.push({
      role: "assistant",
      text: reply
    });

    // Keep memory from becoming too large
    if (conversation.messages.length > 20) {
      conversation.messages =
        conversation.messages.slice(-20);
    }

    console.log(
      `Bot reply to ${from}: ${reply}`
    );

    // Send reply to customer
    await sendWhatsAppMessage(
      from,
      reply
    );

  } catch (error) {

    console.error(
      "Webhook processing error:",
      error?.response?.data ||
      error?.message ||
      error
    );
  }
});


// ============================================================
// SEND WHATSAPP MESSAGE
// ============================================================

async function sendWhatsAppMessage(
  to,
  body
) {

  const url =
    `https://graph.facebook.com/v23.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response =
    await axios.post(
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

  console.log(
    "WhatsApp message sent:",
    response.data
  );

  return response.data;
}


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {

  console.log(
    `Noah WhatsApp AI Business Bot running on port ${PORT}`
  );

});
