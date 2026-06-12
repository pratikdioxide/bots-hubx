/**
 * NestX · TG Forward Bot
 * Listens to Supabase realtime. When the other user sends a message
 * on your NestX chat, it forwards a notification to your Telegram —
 * disguised as a casual update so it blends in your notifications.
 *
 * ENV VARS:
 *   TG_FWD_BOT_TOKEN     Telegram bot token
 *   TG_CHAT_ID           Your Telegram chat ID where alerts go
 *   SUPABASE_URL         e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY Supabase service-role secret key
 *   ADMIN_SENDER_ID      UUID of your admin user — their messages are skipped
 *   CHAT_SECRET          Same as VITE_CHAT_SECRET in your NestX web app
 */

const { createClient } = require("@supabase/supabase-js");
const { webcrypto } = require("crypto");
const { botStatuses } = require("./state");

const crypto = webcrypto;

const {
  TG_FWD_BOT_TOKEN,
  TG_CHAT_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ADMIN_SENDER_ID,
  CHAT_SECRET,
} = process.env;

const state = botStatuses.tgForward;

if (!TG_FWD_BOT_TOKEN || !TG_CHAT_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  state.status = "error";
  state.error = "Missing required env vars";
  console.error("[TGFwd] Missing required env vars — bot disabled.");
  return;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Disguise templates ────────────────────────────────────────────────────────
const TEMPLATES = [
  (t) => `🌤 <b>Weather Update</b>\nToday's forecast: <i>${t}</i>\nStay prepared.`,
  (t) => `📰 <b>News Flash</b>\nBreaking: <i>${t}</i>`,
  (t) => `📈 <b>Market Report</b>\nLatest signal: <i>${t}</i>`,
  (t) => `🌿 <b>Daily Tip</b>\n"<i>${t}</i>"`,
  (t) => `🔔 <b>Reminder</b>\nDon't forget: <i>${t}</i>`,
  (t) => `🛰 <b>System Alert</b>\nStatus update: <i>${t}</i>`,
];

// ── Decryption ────────────────────────────────────────────────────────────────
let _keyPromise = null;
async function getKey() {
  if (_keyPromise) return _keyPromise;
  _keyPromise = (async () => {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(CHAT_SECRET || "fallback-no-secret"), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: enc.encode("nest-chat-salt-v1"), iterations: 100_000, hash: "SHA-256" },
      keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
  })();
  return _keyPromise;
}

async function decrypt(ciphertext) {
  if (!ciphertext || !CHAT_SECRET) return ciphertext;
  if (!ciphertext.startsWith("enc:")) return ciphertext;
  try {
    const key = await getKey();
    const data = Buffer.from(ciphertext.slice(4), "base64");
    const iv = data.subarray(0, 12);
    const payload = data.subarray(12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, payload);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

// ── Telegram sender ───────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_FWD_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("[TGFwd] Telegram API error:", body);
  }
}

function truncate(str, max = 100) {
  if (!str) return "(media)";
  return str.length > max ? str.slice(0, max) + "…" : str;
}

// ── Realtime listener ─────────────────────────────────────────────────────────
supabase
  .channel("tg-fwd-listener")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "messages" },
    async ({ new: row }) => {
      if (row.sender_id === ADMIN_SENDER_ID) return;

      let preview;
      if (row.content) {
        const plain = await decrypt(row.content);
        preview = truncate(plain || row.content);
      } else if (row.image_url) {
        preview = row.file_type === "audio" ? "(voice message)" : `(${row.file_type || "media"})`;
      } else {
        preview = "(empty)";
      }

      const template = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
      await sendTelegram(template(preview));

      state.forwarded++;
      state.last_forwarded = new Date().toISOString();
    }
  )
  .subscribe((status) => {
    console.log("[TGFwd] Realtime status:", status);
    if (status === "SUBSCRIBED") {
      state.status = "online";
      state.error = null;
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      state.status = "error";
      state.error = `Realtime: ${status}`;
    }
  });

console.log("[TGFwd] Forward bot running 📡");