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
// YOUR PERSONAL WHATSAPP NUMBER & CONFIGURATION
// Ghana format: 0547100951 -> 233547100951
// ============================================================

const OWNER_WHATSAPP_NUMBER = "233547100951";

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
- Explain how Stony_Tech can help.
- Be friendly, professional and natural.
- Keep WhatsApp replies reasonably short.
- Never invent prices.
`.trim();

const PERSONAL_FALLBACK_RULES = `
You are replying temporarily on behalf of Noah's personal WhatsApp account because he hasn't been able to reply for a little while. 
Be polite, natural, helpful, and concise like a human personal assistant filling in.
`.trim();


// ============================================================
// MEMORY STORES
// ============================================================

const businessConversations = new Map();
const personalConversations = new Map();

function getBusinessChat(phone) {
  if (!businessConversations.has(phone)) {
    businessConversations.set(phone, { messages: [], lead: {} });
  }
  return businessConversations.get(phone);
}

function getPersonalChat(phone) {
  if (!personalConversations.has(phone)) {
    personalConversations.set(phone, {
      messages: [],
      ownerReplied: false,
      pendingTimeout: null
    });
  }
  return personalConversations.get(phone);
}


// ============================================================
// GEMINI HELPERS
// ============================================================

async function askGemini(systemRules, conversationObj) {
  const history = conversationObj.messages
    .slice(-12)
    .map(item => `${item.role}: ${item.text}`)
    .join("\n");

  const prompt = `
RULES:
${systemRules}

CONVERSATION:
${history}

Respond naturally and concisely.
`.trim();

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await ai.models.generateContent({
        model,
        contents: prompt
      });
      const reply = result.text?.trim();
      if (reply) return reply;
      throw new Error("Empty Gemini response.");
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    }
  }
}


// ============================================================
// META WEBHOOK VERIFICATION & STATUS ENDPOINTS
// ============================================================

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook verified.");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.get("/", (req, res) => {
  res.status(200).send("Dual-Mode WhatsApp Bot & Personal Fallback System is running.");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});


// ============================================================
// INCOMING WEBHOOK HANDLER
// ============================================================

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) return;
    if (message.type !== "text") return;

    const from = message.from;
    const userText = message.text?.body?.trim();
    const recipientPhoneId = value?.metadata?.phone_number_id;

    if (!from || !userText) return;

    // ========================================================
    // SCENARIO 1: YOU (OWNER) REPLIED MANUALLY
    // ========================================================
    if (from === OWNER_WHATSAPP_NUMBER || value?.statuses) {
      console.log("Owner manual action detected.");
      // Cancel timers for personal chats because you stepped in
      for (const [customerPhone, chatObj] of personalConversations.entries()) {
        chatObj.ownerReplied = true;
        if (chatObj.pendingTimeout) {
          clearTimeout(chatObj.pendingTimeout);
          chatObj.pendingTimeout = null;
        }
      }
      return;
    }

    // ========================================================
    // SCENARIO 2: THE BOT NUMBER API (Stony_Tech Business Bot)
    // Runs normally and instantly responds to every message
    // ========================================================
    if (recipientPhoneId === WHATSAPP_PHONE_NUMBER_ID) {
      console.log(`Business Bot message from ${from}: ${userText}`);

      const chat = getBusinessChat(from);
      chat.messages.push({ role: "customer", text: userText });

      const reply = await askGemini(BUSINESS_RULES, chat);
      chat.messages.push({ role: "assistant", text: reply });

      await sendWhatsAppMessage(from, reply, recipientPhoneId);
      return;
    }

    // ========================================================
    // SCENARIO 3: YOUR PERSONAL NUMBER INBOX (20-Minute Fallback)
    // ========================================================
    console.log(`Personal inbox message from ${from}: ${userText}`);

    const personalChat = getPersonalChat(from);
    personalChat.messages.push({ role: "customer", text: userText });
    personalChat.ownerReplied = false;

    if (personalChat.pendingTimeout) {
      clearTimeout(personalChat.pendingTimeout);
    }

    // Set 20-minute fallback timer (20 mins = 1200000 ms)
    // Tip: Change to 30000 (30 seconds) temporarily for quick testing
    personalChat.pendingTimeout = setTimeout(async () => {
      console.log(`⏱️ 20-minute window elapsed for personal chat with ${from}.`);

      if (!personalChat.ownerReplied) {
        console.log(`🤖 You haven't replied. Bot taking over personal chat for ${from}...`);

        const fallbackReply = await askGemini(PERSONAL_FALLBACK_RULES, personalChat);
        personalChat.messages.push({ role: "assistant", text: fallbackReply });

        await sendWhatsAppMessage(from, fallbackReply, recipientPhoneId);
      } else {
        console.log(`✨ You already replied to ${from}. Bot stays quiet.`);
      }

      personalChat.pendingTimeout = null;
    }, 20 * 60 * 1000);

  } catch (error) {
    console.error("Webhook processing error:", error?.message || error);
  }
});


// ============================================================
// SEND WHATSAPP MESSAGE HELPER
// ============================================================

async function sendWhatsAppMessage(to, body, phoneNumberId) {
  const activeId = phoneNumberId || WHATSAPP_PHONE_NUMBER_ID;
  const url = `https://graph.facebook.com/v23.0/${activeId}/messages`;

  const response = await axios.post(
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
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );

  console.log("WhatsApp message sent successfully:", response.data);
  return response.data;
}


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`Dual-mode WhatsApp automation running on port ${PORT}`);
});
