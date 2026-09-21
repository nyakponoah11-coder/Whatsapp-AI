require("dotenv").config();

const crypto  = require("crypto");
const express = require("express");
const axios   = require("axios");
const fs      = require("fs");
const pino    = require("pino");

const { GoogleGenerativeAI } = require("@google/generative-ai");
const { Groq } = require("groq-sdk");

const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = baileys;

const { Boom } = require("@hapi/boom");

const app = express();
app.use(express.json({ limit: "2mb" }));
const PORT = process.env.PORT || 10000;

// =====================================================
// CONFIG
// =====================================================

const OWNER_NUMBER      = "233547100951";
const FALLBACK_DELAY_MS = 10 * 60 * 1000;        // owner gets 1 minute to reply first
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;      // ignore stale / history-sync messages
const AUTH_FOLDER_MAIN  = "./baileys_auth";
const AUTH_FOLDER_SEC   = "./baileys_auth_second";
const LID_MAP_FILE      = "./lid_mappings.json";

// true  = after takeover the AI keeps answering that customer until YOU reply manually
// false = every new customer message restarts the 1-minute owner timer (takeover intro repeats)
const BOT_STAYS_ACTIVE_UNTIL_OWNER_REPLIES = true;

// Session-specific block lists. "meta" = the official WhatsApp Business API number (optional).
const BLOCKED_NUMBERS = {
  main:   ["233599779237", "233550901484", "233599599254", "233243682726"],
  second: ["233535840183", "233267103209", "233547100951"],
  meta:   []
};

const baileysSessions = {
  main:   { phone: "233547100951", qr: null, connected: false, sock: null },
  second: { phone: "233533161186", qr: null, connected: false, sock: null }
};

const WHATSAPP_ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_VERIFY_TOKEN    = process.env.WHATSAPP_VERIFY_TOKEN;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL   = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL   = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

// Optional: enables POST /admin/block and /admin/unblock. Routes are disabled if unset.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const groq  = GROQ_API_KEY   ? new Groq({ apiKey: GROQ_API_KEY })     : null;

const TAKEOVER_MESSAGE =
  "Hi! 👋 Stony is not currently available, but I'm the assistant and I'm here to help you.\n\nHow can I assist you please?";

// =====================================================
// LOGGING
// =====================================================

function log(scope, text) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${scope} ${text}`);
}

function scopeOf(sessionKey, phone) {
  return phone ? `[${sessionKey} +${phone}]` : `[${sessionKey}]`;
}

function describeError(error) {
  if (error?.response?.data) {
    try { return JSON.stringify(error.response.data); } catch (_) {}
  }
  return error?.stack || error?.message || String(error);
}

function preview(text, max = 60) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

process.on("unhandledRejection", (reason) => console.error("❌ Unhandled rejection:", reason));
process.on("uncaughtException",  (error)  => console.error("❌ Uncaught exception:", error));

// =====================================================
// PHONE / JID HELPERS
// =====================================================

// Digits only, device suffix stripped ("233…:12@s.whatsapp.net" -> "233…").
// NEVER use this on a @lid JID to obtain a phone number — LID digits are not phone digits.
function normalizePhone(value) {
  if (!value) return null;
  const local  = String(value).split("@")[0].split(":")[0];
  const digits = local.replace(/\D/g, "");
  return digits || null;
}

function lidDigits(lid) {
  if (!lid) return null;
  const digits = String(lid).split("@")[0].split(":")[0].replace(/\D/g, "");
  return digits || null;
}

const isPnJid  = (jid) => typeof jid === "string" && jid.endsWith("@s.whatsapp.net");
const isLidJid = (jid) => typeof jid === "string" && jid.endsWith("@lid");

// Small set whose entries expire (used for bot-message echo detection and webhook de-dupe)
function createTtlSet(ttlMs) {
  const map = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - ttlMs;
    for (const [k, t] of map) if (t < cutoff) map.delete(k);
  }, 60 * 1000);
  if (timer.unref) timer.unref();
  return {
    add: (k) => { if (k) map.set(k, Date.now()); },
    has: (k) => map.has(k),
    get size() { return map.size; }
  };
}

const botMessageIds      = createTtlSet(15 * 60 * 1000);  // IDs of messages WE sent via Baileys
const seenMetaMessageIds = createTtlSet(60 * 60 * 1000);

// =====================================================
// LID <-> PHONE MAPPING
// =====================================================

const lidToPhone = new Map();
const phoneToLid = new Map();
let lidPersistTimer = null;

function schedulePersistLidMappings() {
  if (lidPersistTimer) return;
  lidPersistTimer = setTimeout(() => {
    lidPersistTimer = null;
    try {
      fs.writeFileSync(LID_MAP_FILE, JSON.stringify(Object.fromEntries(lidToPhone)));
    } catch (error) {
      console.warn("⚠️ Could not persist LID mappings:", error.message);
    }
  }, 2000);
}

function loadLidMappings() {
  try {
    if (!fs.existsSync(LID_MAP_FILE)) return;
    const data = JSON.parse(fs.readFileSync(LID_MAP_FILE, "utf8"));
    for (const [lid, phone] of Object.entries(data)) {
      if (lid && phone) {
        lidToPhone.set(lid, phone);
        phoneToLid.set(phone, lid);
      }
    }
    log("[lid]", `Loaded ${lidToPhone.size} LID mappings from disk`);
  } catch (error) {
    console.warn("⚠️ Could not load LID mappings:", error.message);
  }
}

function saveLidMapping(lid, phone, source = "unknown") {
  if (!lid || !phone) return false;
  if (!String(lid).includes("@lid") && !/^\d+$/.test(String(lid))) return false;
  if (String(phone).includes("@lid")) return false;          // never store a LID as a "phone"

  const cleanLid   = lidDigits(lid);
  const cleanPhone = normalizePhone(phone);
  if (!cleanLid || !cleanPhone) return false;
  if (!/^\d{8,15}$/.test(cleanPhone)) return false;          // implausible phone number
  if (cleanLid === cleanPhone) return false;                 // a LID mapped to itself is not a real mapping

  const existing = lidToPhone.get(cleanLid);
  if (existing === cleanPhone) return true;
  if (existing && existing !== cleanPhone) {
    console.warn(`⚠️ [lid] mapping changed for ${cleanLid}: +${existing} -> +${cleanPhone} (${source})`);
  } else {
    log("[lid]", `mapped ${cleanLid} -> +${cleanPhone} (${source})`);
  }
  lidToPhone.set(cleanLid, cleanPhone);
  phoneToLid.set(cleanPhone, cleanLid);
  schedulePersistLidMappings();
  return true;
}

function phoneFromLid(lid) {
  const digits = lidDigits(lid);
  return digits ? (lidToPhone.get(digits) || null) : null;
}

// Phone for any JID, or null if it can't be determined safely.
function jidToPhone(jid) {
  if (!jid) return null;
  if (isLidJid(jid)) return phoneFromLid(jid);
  if (isPnJid(jid)) return normalizePhone(jid);
  return null;
}

function learnFromContact(contact) {
  if (!contact) return;
  const { id, lid, phoneNumber } = contact;
  if (isPnJid(id) && isLidJid(lid)) saveLidMapping(lid, id, "contact");
  else if (isLidJid(id) && phoneNumber) saveLidMapping(id, phoneNumber, "contact");
}

function bindLidLearning(sock) {
  const safe = (fn) => (...args) => { try { fn(...args); } catch (e) { console.warn("⚠️ [lid] handler error:", e.message); } };

  sock.ev.on("contacts.upsert", safe((contacts) => contacts.forEach(learnFromContact)));
  sock.ev.on("contacts.update", safe((contacts) => contacts.forEach(learnFromContact)));

  // Emitted by newer Baileys versions when WhatsApp reveals LID <-> phone pairs
  sock.ev.on("chats.phoneNumberShare", safe(({ lid, jid }) => saveLidMapping(lid, jid, "phoneNumberShare")));
  sock.ev.on("lid-mapping.update",     safe(({ lid, pn })  => saveLidMapping(lid, pn, "lid-mapping.update")));

  sock.ev.on("messaging-history.set", safe(({ contacts, lidPnMappings }) => {
    (contacts || []).forEach(learnFromContact);
    (lidPnMappings || []).forEach((m) => saveLidMapping(m?.lid, m?.pn, "history"));
  }));
}

// Ask WhatsApp for the LIDs of blocked numbers up front, so a blocked person who
// arrives as a LID is recognised even before WhatsApp reveals their phone number.
async function seedBlockedLids(sessionKey, sock) {
  const lm = sock?.signalRepository?.lidMapping;
  if (!lm || typeof lm.getLIDForPN !== "function") {
    log(scopeOf(sessionKey), "ℹ️ LID pre-seeding not supported by this Baileys version (blocked numbers are still matched by phone).");
    return;
  }
  let seeded = 0;
  for (const phone of blockedSets[sessionKey] || []) {
    try {
      const lid = await lm.getLIDForPN(`${phone}@s.whatsapp.net`);
      if (lid && saveLidMapping(lid, phone, "seed-blocked")) seeded++;
    } catch (error) {
      log(scopeOf(sessionKey), `ℹ️ Could not pre-seed LID for +${phone}: ${error.message}`);
    }
  }
  log(scopeOf(sessionKey), `LID pre-seed done (${seeded}/${(blockedSets[sessionKey] || new Set()).size} blocked numbers)`);
}

// =====================================================
// BLOCK LIST (exact match, session-specific)
// =====================================================

const blockedSets = {};
for (const [key, list] of Object.entries(BLOCKED_NUMBERS)) {
  blockedSets[key] = new Set(list.map((n) => normalizePhone(n)).filter(Boolean));
}

function isBlockedForSession(sessionKey, identifier) {
  if (!identifier) return false;
  const normalized = normalizePhone(identifier);
  if (!normalized || normalized.length < 6) return false;
  const set = blockedSets[sessionKey];
  return !!set && set.has(normalized);      // exact match only — never endsWith
}

function isTotallyBlocked(sessionKey, identifiers = []) {
  return identifiers.filter(Boolean).some((id) => isBlockedForSession(sessionKey, id));
}

function isBlockedJid(sessionKey, jid) {
  return isBlockedForSession(sessionKey, jidToPhone(jid));
}

// A conversation is blocked if ANY identifier we know for it is blocked.
function isChatBlocked(sessionKey, chat) {
  const ids = [chat.phone];
  for (const jid of chat.jids || []) ids.push(jidToPhone(jid));
  return isTotallyBlocked(sessionKey, ids);
}

// =====================================================
// CONVERSATION STATE
// =====================================================

const personalChats = new Map();   // key: `${sessionKey}:${phone}` -> per-session, per-customer state
const metaChats     = new Map();   // key: phone

const convKey = (sessionKey, phone) => `${sessionKey}:${phone}`;
const newLead = () => ({ name: null, business: null, businessType: null, requirement: null });

function getPersonalChat(sessionKey, phone) {
  const key = convKey(sessionKey, phone);
  if (!personalChats.has(key)) {
    personalChats.set(key, {
      sessionKey,
      phone,
      messages: [],
      ownerReplied: false,
      botActive: false,       // AI has taken over this conversation
      busy: false,            // AI turn currently running
      rerun: false,           // customer wrote while AI was busy
      epoch: 0,               // bumped whenever pending bot work must be invalidated
      fallbackTimer: null,
      lastCustomerMessage: null,
      lastJid: null,
      jids: new Set(),
      leadNotified: false,
      lead: newLead()
    });
  }
  return personalChats.get(key);
}

function getMetaChat(phone) {
  if (!metaChats.has(phone)) {
    metaChats.set(phone, {
      messages: [],
      lastCustomerMessage: null,
      leadNotified: false,
      lead: newLead()
    });
  }
  return metaChats.get(phone);
}

function saveMessage(chat, role, content) {
  if (!content) return;
  chat.messages.push({ role, content, timestamp: Date.now() });
  if (chat.messages.length > 30) chat.messages = chat.messages.slice(-30);
}

// =====================================================
// MESSAGE PARSING
// =====================================================

function unwrapMessage(message) {
  let m = message;
  for (let i = 0; i < 5 && m; i++) {
    const inner =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.viewOnceMessageV2Extension?.message ||
      m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

function primaryMessageType(message) {
  const m = unwrapMessage(message);
  if (!m) return "unknown";
  return Object.keys(m).find((k) => k !== "messageContextInfo") || "unknown";
}

function extractMessageText(message) {
  const m = unwrapMessage(message);
  if (!m) return "";
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText;
  if (m.listResponseMessage?.title) return m.listResponseMessage.title;
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return m.listResponseMessage.singleSelectReply.selectedRowId;
  if (m.templateButtonReplyMessage?.selectedDisplayText) return m.templateButtonReplyMessage.selectedDisplayText;
  return "";
}

function messageTimeMs(msg) {
  const ts = Number(msg?.messageTimestamp);
  return ts > 0 ? ts * 1000 : Date.now();
}

// Things the owner's account emits that are NOT a human reply
const NON_REPLY_TYPES = new Set(["protocolMessage", "senderKeyDistributionMessage", "reactionMessage"]);

// =====================================================
// LEAD DETECTION
// =====================================================

function detectInterest(text) {
  if (!text) return false;
  const msg = text.toLowerCase().trim();
  const phrases = [
    "i'm interested", "im interested", "i am interested",
    "i want one", "i need one", "i want a bot", "i need a bot",
    "i want you to build", "i need you to build",
    "build one for me", "build it for me", "can you build one",
    "i want to get started", "how can i get started",
    "let's do it", "lets do it", "i need your service", "how much is it"
  ];
  return phrases.some((p) => msg.includes(p));
}

function updateLeadInformation(chat, text) {
  if (!text) return;
  const msg = text.toLowerCase();
  if (msg.includes("restaurant") || msg.includes("food") || msg.includes("chop bar")) chat.lead.businessType = "Food / Restaurant";
  if (msg.includes("school") || msg.includes("university") || msg.includes("college")) chat.lead.businessType = "School / Education";
  if (msg.includes("shop") || msg.includes("store") || msg.includes("clothing")) chat.lead.businessType = "Shop / Retail";
  if (msg.includes("hotel") || msg.includes("guest house")) chat.lead.businessType = "Hotel / Hospitality";
  if (msg.includes("delivery")) chat.lead.businessType = "Delivery";
  if (msg.includes("bot") || msg.includes("automation") || msg.includes("whatsapp")) chat.lead.requirement = text;
}

// =====================================================
// AI
// =====================================================

function buildConversationPrompt(messages) {
  return messages.slice(-12).map((m) => {
    const role = m.role === "user" ? "Customer" : m.role === "owner" ? "Stony (owner)" : "Assistant";
    return `${role}: ${m.content}`;
  }).join("\n");
}

const SYSTEM_PROMPT = `
You are the official AI assistant for Stony_Tech.

Stony_Tech builds:
- WhatsApp bots and AI assistants
- Business automation systems
- WhatsApp ordering systems
- Customer support automation
- Booking systems and payment integrations
- Business dashboards and custom software

Your job is to speak naturally with customers and understand what they need.

Rules:
- Be friendly and professional.
- Keep replies concise and natural — do not sound robotic.
- Do not invent prices. If pricing is asked, say it depends on project requirements.
- Ask useful questions when necessary.
- If someone wants a WhatsApp bot, ask about their business and what the bot should do.
- Guide interested customers toward getting started with Stony_Tech.
`.trim();

async function askAI(messages) {
  const conversation = buildConversationPrompt(messages);

  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: SYSTEM_PROMPT
      });
      const result = await model.generateContent(conversation);
      const text = result?.response?.text();
      if (text) return text.trim();
    } catch (error) {
      console.warn("⚠️ Gemini failed, falling back to Groq:", error.message);
    }
  }

  if (groq) {
    try {
      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: conversation }
        ],
        temperature: 0.7,
        max_tokens: 500
      });
      const text = completion?.choices?.[0]?.message?.content;
      if (text) return text.trim();
    } catch (error) {
      console.error("❌ Groq fallback failed:", error.message);
    }
  }

  return "Sorry, I'm having a little trouble responding right now. Please try again shortly.";
}

// =====================================================
// META (OFFICIAL API) SENDING + OWNER NOTIFICATION
// =====================================================

async function sendBotMessage(to, text) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) throw new Error("Meta credentials missing");
  const url = `https://graph.facebook.com/v23.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const response = await axios.post(
    url,
    { messaging_product: "whatsapp", to: normalizePhone(to), type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
  );
  return response.data;
}

async function notifyOwner(chat, customerPhone, source) {
  if (chat.leadNotified) return;
  chat.leadNotified = true;
  const message =
    `🚨 NEW STONY_TECH LEAD\n\n` +
    `📱 Customer:\n+${customerPhone}\n\n` +
    `📥 Via:\n${source}\n\n` +
    `🏢 Business:\n${chat.lead.businessType || "Not identified"}\n\n` +
    `💡 Requirement:\n${chat.lead.requirement || "Not identified"}\n\n` +
    `The customer appears interested in Stony_Tech services.`;
  try {
    await sendBotMessage(OWNER_NUMBER, message);
    log("[lead]", `Owner notified about +${customerPhone} (${source})`);
  } catch (error) {
    chat.leadNotified = false;   // allow a retry on the next interested message
    console.error("❌ Failed to notify owner:", describeError(error));
  }
}

// =====================================================
// CONVERSATION CONTROL (timer / takeover)
// =====================================================

function cancelFallbackTimer(chat) {
  if (chat.fallbackTimer) {
    clearTimeout(chat.fallbackTimer);
    chat.fallbackTimer = null;
  }
}

// Kills any pending or in-flight bot work for this conversation.
function cancelConversation(sessionKey, chat, reason) {
  const hadTimer = !!chat.fallbackTimer;
  cancelFallbackTimer(chat);
  chat.epoch++;
  chat.botActive = false;
  chat.rerun = false;
  log(scopeOf(sessionKey, chat.phone), `🛑 Bot work cancelled (${reason})${hadTimer ? " — pending timer cleared" : ""}`);
}

// Returns null if the bot may still send, otherwise a human-readable reason.
function guardBotSend(sessionKey, chat, epoch) {
  if (isChatBlocked(sessionKey, chat)) {
    cancelConversation(sessionKey, chat, "number is blocked");
    return "number is blocked";
  }
  if (chat.epoch !== epoch)  return "timer was reset or owner replied";
  if (chat.ownerReplied)     return "owner replied";
  const session = baileysSessions[sessionKey];
  if (!session?.sock || !session.connected) return "WhatsApp session not connected";
  return null;
}

function makeBotMessageId(sock) {
  try {
    if (typeof baileys.generateMessageIDV2 === "function") return baileys.generateMessageIDV2(sock?.user?.id);
    if (typeof baileys.generateMessageID === "function")   return baileys.generateMessageID();
  } catch (_) {}
  return "3EB0" + crypto.randomBytes(18).toString("hex").toUpperCase();
}

// Every message the bot sends is registered BEFORE sending, so its echo
// (fromMe) is never mistaken for you replying manually.
async function sendBotText(sessionKey, chat, jid, text) {
  const sock = baileysSessions[sessionKey]?.sock;
  if (!sock) throw new Error("no active socket");
  if (!jid)  throw new Error("no JID known for this conversation");
  const messageId = makeBotMessageId(sock);
  botMessageIds.add(messageId);
  const sent = await sock.sendMessage(jid, { text }, { messageId });
  if (sent?.key?.id) botMessageIds.add(sent.key.id);
  saveMessage(chat, "assistant", text);
}

async function runBotTurn(sessionKey, chat, epoch, withIntro) {
  const scope = scopeOf(sessionKey, chat.phone);
  const jid = chat.lastJid;

  if (chat.busy) {
    chat.rerun = true;
    log(scope, "⏳ AI is mid-reply — new message queued");
    return;
  }

  chat.busy = true;
  chat.botActive = true;

  const bail = (reason, stage) => {
    log(scope, `⏹️ ${stage} suppressed — ${reason}`);
    chat.botActive = false;
  };

  try {
    let why;

    if (withIntro) {
      if ((why = guardBotSend(sessionKey, chat, epoch))) return bail(why, "takeover message");
      await sendBotText(sessionKey, chat, jid, TAKEOVER_MESSAGE);
      log(scope, "🤖 Takeover message sent");
    }

    do {
      chat.rerun = false;

      if ((why = guardBotSend(sessionKey, chat, epoch))) return bail(why, "AI reply");
      const aiReply = await askAI(chat.messages);

      // Re-check after the (slow) AI call: owner may have replied or number may have been blocked meanwhile
      if ((why = guardBotSend(sessionKey, chat, epoch))) return bail(why, "AI reply (after generation)");
      await sendBotText(sessionKey, chat, jid, aiReply);
      log(scope, `🤖 AI reply sent: "${preview(aiReply)}"`);
    } while (chat.rerun);
  } catch (error) {
    console.error(`${scope} ❌ AI turn failed:`, describeError(error));
  } finally {
    chat.busy = false;
    if (!BOT_STAYS_ACTIVE_UNTIL_OWNER_REPLIES) chat.botActive = false;
  }
}

function startFallbackTimer(sessionKey, chat, jid) {
  const scope = scopeOf(sessionKey, chat.phone);

  if (isChatBlocked(sessionKey, chat)) {
    log(scope, "🚫 BLOCKED — owner timer NOT started");
    return;
  }

  const restarting = !!chat.fallbackTimer;
  cancelFallbackTimer(chat);
  chat.ownerReplied = false;
  chat.lastJid = jid;
  const epoch = ++chat.epoch;

  log(scope, `⏳ Owner-response timer ${restarting ? "restarted" : "started"} (${Math.round(FALLBACK_DELAY_MS / 1000)}s)`);

  chat.fallbackTimer = setTimeout(async () => {
    chat.fallbackTimer = null;

    const why = guardBotSend(sessionKey, chat, epoch);
    if (why) {
      log(scope, `⏹️ Timer fired but takeover suppressed — ${why}`);
      return;
    }

    log(scope, "⏰ No owner reply in time — AI takeover starting");
    await runBotTurn(sessionKey, chat, epoch, true);
  }, FALLBACK_DELAY_MS);
}

// =====================================================
// RUNTIME BLOCKING (optional admin API)
// =====================================================

function blockNumber(sessionKey, number) {
  const n = normalizePhone(number);
  if (!blockedSets[sessionKey] || !n) return false;
  blockedSets[sessionKey].add(n);
  log(scopeOf(sessionKey), `🚫 +${n} added to block list (in-memory; edit BLOCKED_NUMBERS to make it permanent)`);
  const chat = personalChats.get(convKey(sessionKey, n));
  if (chat) cancelConversation(sessionKey, chat, "number was just blocked");
  return true;
}

function unblockNumber(sessionKey, number) {
  const n = normalizePhone(number);
  if (!blockedSets[sessionKey] || !n) return false;
  const removed = blockedSets[sessionKey].delete(n);
  if (removed) log(scopeOf(sessionKey), `✅ +${n} removed from block list (in-memory)`);
  return removed;
}

// =====================================================
// BAILEYS: SENDER RESOLUTION
// =====================================================

// Returns { phone, source } or null. Never guesses: LID digits are NOT phone digits.
async function resolveSenderNumber(sock, msg) {
  const key = msg?.key || {};
  const remoteJid = key.remoteJid;
  const fromMe = !!key.fromMe;

  if (isPnJid(remoteJid)) {
    const phone = normalizePhone(remoteJid);
    if (isLidJid(key.remoteJidAlt)) saveLidMapping(key.remoteJidAlt, remoteJid, "remoteJidAlt");
    return phone ? { phone, source: "phone-jid" } : null;
  }

  if (isLidJid(remoteJid)) {
    // 1) cache
    const cached = phoneFromLid(remoteJid);
    if (cached) return { phone: cached, source: "cache" };

    // 2) phone JID delivered alongside the LID.
    //    For our own messages only remoteJidAlt is safe (senderPn could be OUR number).
    const candidates = [["remoteJidAlt", key.remoteJidAlt]];
    if (!fromMe) candidates.push(["senderPn", key.senderPn]);
    for (const [source, value] of candidates) {
      if (isPnJid(value) && saveLidMapping(remoteJid, value, source)) {
        return { phone: normalizePhone(value), source };
      }
    }

    // 3) Baileys' own LID mapping store (newer versions)
    try {
      const lm = sock?.signalRepository?.lidMapping;
      if (lm && typeof lm.getPNForLID === "function") {
        const pn = await lm.getPNForLID(remoteJid);
        if (pn && !String(pn).includes("@lid") && saveLidMapping(remoteJid, pn, "lidMapping.getPNForLID")) {
          return { phone: normalizePhone(pn), source: "lidMapping.getPNForLID" };
        }
      }
    } catch (error) {
      log(scopeOf("lid"), `ℹ️ getPNForLID failed: ${error.message}`);
    }

    return null;   // unresolved — caller must NOT reply
  }

  return null;
}

// =====================================================
// BAILEYS: MESSAGE HANDLING
// =====================================================

function handleBlockedHit(sessionKey, phone, stage) {
  log(scopeOf(sessionKey, phone), `🚫 BLOCKED (${stage}) — no reply, no timer, no AI`);
  if (phone) {
    const chat = personalChats.get(convKey(sessionKey, phone));
    if (chat) cancelConversation(sessionKey, chat, "blocked number");
  }
}

function handleOwnerMessage(sessionKey, chat, msg) {
  const scope = scopeOf(sessionKey, chat.phone);
  const type = primaryMessageType(msg.message);

  if (NON_REPLY_TYPES.has(type)) return;   // protocol noise / reactions are not a reply

  cancelFallbackTimer(chat);
  chat.epoch++;            // invalidates any in-flight AI work for THIS conversation only
  chat.ownerReplied = true;
  chat.botActive = false;
  chat.rerun = false;

  const text = extractMessageText(msg.message);
  saveMessage(chat, "owner", text || `[owner sent ${type}]`);
  log(scope, `👤 You replied manually — AI stopped for this conversation only${text ? `: "${preview(text)}"` : ` (${type})`}`);
}

async function handleUpsertMessage(sessionKey, sock, msg, type) {
  const key = msg?.key;
  if (!key?.remoteJid || !msg.message) return;

  const remoteJid = key.remoteJid;
  const fromMe = !!key.fromMe;

  // Not 1-to-1 chats
  if (
    remoteJid === "status@broadcast" ||
    remoteJid.endsWith("@g.us") ||
    remoteJid.endsWith("@broadcast") ||
    remoteJid.endsWith("@newsletter")
  ) return;

  if (!isPnJid(remoteJid) && !isLidJid(remoteJid)) {
    log(scopeOf(sessionKey), `SKIP unsupported JID type: ${remoteJid}`);
    return;
  }

  // Our own bot's outgoing messages echo back as fromMe — they are NOT you replying.
  if (fromMe && key.id && botMessageIds.has(key.id)) return;

  // Stale / history-sync messages must never trigger timers or replies
  const ageMs = Date.now() - messageTimeMs(msg);
  if (ageMs > MAX_MESSAGE_AGE_MS) {
    log(scopeOf(sessionKey), `SKIP old message (${Math.round(ageMs / 1000)}s old) from ${remoteJid}`);
    return;
  }
  if (!fromMe && type !== "notify") {
    log(scopeOf(sessionKey), `SKIP non-realtime message (upsert type "${type}") from ${remoteJid}`);
    return;
  }

  // STEP 1: block check using what we already know about this JID (before any resolving)
  if (isBlockedJid(sessionKey, remoteJid)) {
    handleBlockedHit(sessionKey, jidToPhone(remoteJid), "pre-resolve");
    return;
  }

  // STEP 2: resolve the real phone number
  const resolved = await resolveSenderNumber(sock, msg);
  if (!resolved) {
    log(
      scopeOf(sessionKey),
      `⚠️ SKIP — cannot resolve real phone for ${remoteJid}. Ignoring on purpose: ` +
      `without the phone number the block list can't be checked (fail-closed).`
    );
    return;
  }
  const phone = resolved.phone;
  const scope = scopeOf(sessionKey, phone);

  // STEP 3: definitive block check on the resolved number
  if (isBlockedForSession(sessionKey, phone)) {
    handleBlockedHit(sessionKey, phone, `resolved via ${resolved.source}`);
    return;
  }

  // Chat with our own number ("message yourself")
  if (phone === normalizePhone(baileysSessions[sessionKey].phone)) {
    log(scope, "SKIP — chat with this session's own number");
    return;
  }

  const chat = getPersonalChat(sessionKey, phone);
  chat.jids.add(remoteJid);
  chat.lastJid = remoteJid;

  // You replying manually
  if (fromMe) {
    handleOwnerMessage(sessionKey, chat, msg);
    return;
  }

  // Customer message
  const text = extractMessageText(msg.message);
  if (!text) {
    log(scope, `SKIP non-text message (${primaryMessageType(msg.message)}) — nothing to answer`);
    return;
  }

  log(scope, `📨 "${preview(text, 120)}" (resolved via ${resolved.source})`);
  saveMessage(chat, "user", text);
  chat.lastCustomerMessage = Date.now();

  updateLeadInformation(chat, text);
  if (detectInterest(text)) notifyOwner(chat, phone, `${sessionKey} personal number`);

  // Re-check: state may have changed during the async work above
  if (isChatBlocked(sessionKey, chat)) {
    handleBlockedHit(sessionKey, phone, "post-resolve recheck");
    return;
  }

  if (chat.busy) {
    chat.rerun = true;
    log(scope, "⏳ AI is mid-reply — new message queued");
    return;
  }

  if (chat.botActive) {
    log(scope, "🤖 AI already active for this customer — replying now");
    runBotTurn(sessionKey, chat, chat.epoch, false);   // handles its own errors
    return;
  }

  // New customer message => owner-response timer starts (or restarts) again
  startFallbackTimer(sessionKey, chat, remoteJid);
}

// =====================================================
// BAILEYS CLIENT
// =====================================================

async function startBaileysClient(sessionKey, phone, authFolder) {
  console.log(`\n🚀 Starting ${sessionKey} WhatsApp...`);

  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch (err) {
    console.warn(`⚠️ [${sessionKey}] Could not fetch latest Baileys version, using default:`, err.message);
  }

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["Stony_Tech", "Chrome", "1.0.0"],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  baileysSessions[sessionKey].sock = sock;
  sock.ev.on("creds.update", saveCreds);
  bindLidLearning(sock);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      baileysSessions[sessionKey].qr = qr;
      console.log(`📲 QR ready for ${sessionKey} — open /qr`);
    }

    if (connection === "open") {
      baileysSessions[sessionKey].connected = true;
      baileysSessions[sessionKey].qr = null;
      console.log(`✅ ${sessionKey} connected.`);
      setTimeout(() => {
        seedBlockedLids(sessionKey, sock).catch((e) => console.warn(`⚠️ [${sessionKey}] LID seed failed:`, e.message));
      }, 3000);
    }

    if (connection === "close") {
      baileysSessions[sessionKey].connected = false;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) {
        console.log(`🔄 ${sessionKey} disconnected (code ${statusCode}) — reconnecting in 5s`);
        setTimeout(() => startBaileysClient(sessionKey, phone, authFolder), 5000);
      } else {
        baileysSessions[sessionKey].sock = null;
        console.log(`🔐 ${sessionKey} logged out. Delete auth folder and re-scan.`);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const msg of messages) {
      try {
        await handleUpsertMessage(sessionKey, sock, msg, type);
      } catch (error) {
        console.error(`❌ [${sessionKey}] Message handling error:`, describeError(error));
      }
    }
  });
}

// =====================================================
// META WEBHOOK
// =====================================================

async function handleMetaMessage(message) {
  const from = normalizePhone(message.from);
  const scope = scopeOf("meta", from);

  if (!from) {
    log("[meta]", "SKIP message without a sender");
    return;
  }

  if (message.id) {
    if (seenMetaMessageIds.has(message.id)) {
      log(scope, `SKIP duplicate webhook delivery (${message.id})`);
      return;
    }
    seenMetaMessageIds.add(message.id);
  }

  if (isBlockedForSession("meta", from)) {
    log(scope, "🚫 BLOCKED — no reply, no AI");
    return;
  }

  if (message.type !== "text") {
    log(scope, `SKIP non-text message (${message.type})`);
    return;
  }

  const text = message.text?.body || "";
  if (!text.trim()) {
    log(scope, "SKIP empty text message");
    return;
  }

  log(scope, `📨 "${preview(text, 120)}"`);
  const chat = getMetaChat(from);
  chat.lastCustomerMessage = Date.now();
  saveMessage(chat, "user", text);
  updateLeadInformation(chat, text);
  if (detectInterest(text)) notifyOwner(chat, from, "Meta business number");

  const aiReply = await askAI(chat.messages);

  if (isBlockedForSession("meta", from)) {
    log(scope, "🚫 Blocked while AI was generating — reply discarded");
    return;
  }

  await sendBotMessage(from, aiReply);
  saveMessage(chat, "assistant", aiReply);
  log(scope, `🤖 AI reply sent: "${preview(aiReply)}"`);
}

async function processMetaWebhook(body) {
  if (body?.object !== "whatsapp_business_account") {
    log("[meta]", `SKIP webhook with unexpected object: ${body?.object}`);
    return;
  }
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      for (const message of change.value?.messages || []) {
        try {
          await handleMetaMessage(message);
        } catch (error) {
          console.error(`❌ [meta] Failed handling message ${message?.id} from ${message?.from}:`, describeError(error));
        }
      }
    }
  }
}

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  console.warn("⚠️ [meta] Webhook verification failed (mode/token mismatch)");
  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  res.sendStatus(200);   // acknowledge immediately so Meta doesn't retry
  processMetaWebhook(req.body).catch((error) => {
    console.error("❌ [meta] Webhook processing failed:", describeError(error));
  });
});

// =====================================================
// ADMIN API (disabled unless ADMIN_TOKEN is set)
// =====================================================

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(404).json({ error: "Route not found" });
  const supplied = Buffer.from(String(req.get("x-admin-token") || ""));
  const expected = Buffer.from(ADMIN_TOKEN);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.post("/admin/block", requireAdmin, (req, res) => {
  const { session, number } = req.body || {};
  if (!blockNumber(session, number)) return res.status(400).json({ error: "Invalid session or number" });
  res.json({ ok: true, session, blocked: [...blockedSets[session]] });
});

app.post("/admin/unblock", requireAdmin, (req, res) => {
  const { session, number } = req.body || {};
  if (!blockedSets[session] || !normalizePhone(number)) return res.status(400).json({ error: "Invalid session or number" });
  const removed = unblockNumber(session, number);
  res.json({ ok: true, removed, session, blocked: [...blockedSets[session]] });
});

// =====================================================
// WEB PAGES
// =====================================================

app.get("/qr", (req, res) => {
  const makeQR = (title, qr, connected) => {
    if (connected) return `<div class="card"><h2>${title}</h2><p class="connected">✅ Connected</p></div>`;
    if (!qr) return `<div class="card"><h2>${title}</h2><p>⏳ Waiting for QR...</p></div>`;
    const qrImage = "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" + encodeURIComponent(qr);
    return `<div class="card"><h2>${title}</h2><p>Scan with WhatsApp → Linked Devices → Link a Device</p><img src="${qrImage}" width="300" height="300" alt="QR"/></div>`;
  };
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Stony_Tech QR</title>
    <style>body{margin:0;padding:30px;font-family:Arial;background:#111;color:white;text-align:center}
    .card{background:#1d1d1d;padding:25px;margin:25px auto;border-radius:15px;max-width:380px}
    img{background:white;padding:10px;border-radius:10px;max-width:90%}
    .connected{color:#00ff88;font-weight:bold}
    .info{color:#888;font-size:12px;margin-top:20px}</style></head>
    <body><h1>Stony_Tech WhatsApp</h1>
    ${makeQR("Main Personal Number", baileysSessions.main.qr, baileysSessions.main.connected)}
    ${makeQR("Second Personal Number", baileysSessions.second.qr, baileysSessions.second.connected)}
    <p class="info">LID mappings cached: ${lidToPhone.size} | Auto-refreshes every 10s</p>
    <script>setTimeout(()=>location.reload(),10000)</script></body></html>`);
});

app.get("/blocked", (req, res) => {
  const makeList = (set) => set.size === 0
    ? `<li style="color:#888;font-style:italic">No blocked numbers</li>`
    : [...set].map((n) => `<li><span style="background:#fee2e2;color:#b91c1c;font-size:11px;padding:2px 8px;border-radius:20px;font-weight:700;margin-right:8px">BLOCKED</span>+${n}</li>`).join("");

  res.send(`<!DOCTYPE html><html><head><title>Blocked Numbers</title>
    <style>body{font-family:sans-serif;background:#f4f4f9;padding:30px}
    .card{background:white;border-radius:12px;padding:20px;margin-bottom:20px;max-width:400px;box-shadow:0 2px 8px rgba(0,0,0,0.08)}
    ul{list-style:none;padding:0;margin:0}li{padding:8px 0;border-bottom:1px solid #f0f0f0}li:last-child{border-bottom:none}
    a{color:#2563eb;font-size:13px}</style></head>
    <body><h1>🚫 Blocked Numbers</h1>
    <p style="color:#666;margin-bottom:20px">These numbers get zero auto-replies — no AI, no takeover message, no timer, nothing. Blocking is per session.</p>
    <div class="card"><h2>Main (+${baileysSessions.main.phone})</h2><ul>${makeList(blockedSets.main)}</ul></div>
    <div class="card"><h2>Second (+${baileysSessions.second.phone})</h2><ul>${makeList(blockedSets.second)}</ul></div>
    <div class="card"><h2>Meta Business API</h2><ul>${makeList(blockedSets.meta)}</ul></div>
    <a href="/">← Back</a></body></html>`);
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    geminiModel: GEMINI_MODEL,
    groqModel: GROQ_MODEL,
    main:   { phone: baileysSessions.main.phone,   connected: baileysSessions.main.connected,   blocked: blockedSets.main.size },
    second: { phone: baileysSessions.second.phone, connected: baileysSessions.second.connected, blocked: blockedSets.second.size },
    lidMappings: lidToPhone.size,
    personalChats: personalChats.size,
    metaChats: metaChats.size,
    botMessageIdsTracked: botMessageIds.size
  });
});

app.get("/", (req, res) => {
  res.send(`<html><body style="font-family:Arial;background:#111;color:white;text-align:center;padding:50px">
    <h1>🤖 Stony_Tech AI Assistant</h1>
    <p>WhatsApp automation system is running.</p>
    <p><a href="/qr"      style="color:#00ff88;font-size:20px">📱 Open WhatsApp QR</a></p>
    <p><a href="/blocked" style="color:#ff6b6b;font-size:20px">🚫 Blocked Numbers</a></p>
    <p><a href="/health"  style="color:#00aaff;font-size:20px">❤️  System Health</a></p>
  </body></html>`);
});

app.use((req, res) => res.status(404).json({ error: "Route not found" }));

// =====================================================
// START
// =====================================================

app.listen(PORT, () => {
  console.log(`🚀 Stony_Tech running on port ${PORT}`);
  loadLidMappings();
  startBaileysClient("main",   baileysSessions.main.phone,   AUTH_FOLDER_MAIN);
  startBaileysClient("second", baileysSessions.second.phone, AUTH_FOLDER_SEC);
});
