# WhatsApp Gemini Bot

## Render settings

Build Command:
npm install

Start Command:
npm start

## Render Environment Variables

Add these in Render > Environment:

GEMINI_API_KEY
GEMINI_MODEL
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_VERIFY_TOKEN

Do NOT upload a real .env file containing API keys to GitHub.

## Meta webhook

Callback URL:
https://YOUR-RENDER-SERVICE.onrender.com/webhook

Verify Token:
Use exactly the same value you put in WHATSAPP_VERIFY_TOKEN.

Subscribe your WhatsApp Cloud API app to the messages webhook.

## Test

Send a normal text message to the Meta WhatsApp number.

The flow is:

WhatsApp -> Meta -> /webhook -> Gemini -> Meta -> WhatsApp
