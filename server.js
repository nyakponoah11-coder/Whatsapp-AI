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

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

app.get("/", (req, res) => {
  res.status(200).send("WhatsApp Gemini Bot is running.");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Meta webhook verification
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

// WhatsApp incoming messages
app.post("/webhook", async (req, res) => {
  // Respond immediately so Meta does not retry the webhook.
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    // Only handle normal text messages for now.
    if (message.type !== "text") return;

    const from = message.from;
    const userText = message.text?.body?.trim();

    if (!from || !userText) return;

    console.log(`Incoming message from ${from}: ${userText}`);

    const result = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: userText,
      config: {
        systemInstruction: `
You are a helpful AI assistant responding through WhatsApp.

Be friendly, natural, clear and professional.
Keep replies reasonably short and easy to read on WhatsApp.
Use simple language.
You may use emojis when appropriate.
Do not invent facts.
If you do not know something, say so.
Do not mention internal APIs, webhooks, servers, environment variables or programming unless the user specifically asks.
        `.trim()
      }
    });

    const reply = result.text?.trim();

    if (!reply) {
      await sendWhatsAppMessage(from, "Sorry, I couldn't generate a response. Please try again.");
      return;
    }

    console.log(`Gemini reply to ${from}: ${reply}`);

    await sendWhatsAppMessage(from, reply);
  } catch (error) {
    console.error(
      "Processing error:",
      error?.response?.data || error?.message || error
    );
  }
});

async function sendWhatsAppMessage(to, body) {
  const url = `https://graph.facebook.com/v23.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

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

  console.log("WhatsApp message sent:", response.data);
  return response.data;
}

app.listen(PORT, () => {
  console.log(`WhatsApp Gemini Bot running on port ${PORT}`);
});
