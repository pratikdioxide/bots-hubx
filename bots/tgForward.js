/**
 * NestX · Telegram Forward Bot
 * ------------------------------------
 * Smart notification logic:
 * - Sends a real weather report (Ghaziabad, UP) on the OTHER user's FIRST message
 * - Stays silent for all follow-up messages in the same session
 * - Skips entirely if admin "bleh" is currently online (seen messages recently)
 * - Resends weather report every 30 min if bleh still hasn't read the messages
 * - Resets when bleh reads (seen_at updated) → next conversation starts fresh
 *
 * ENV VARS:
 *   TG_FWD_BOT_TOKEN     Telegram bot token
 *   TG_CHAT_ID           Your Telegram chat ID where alerts go
 *   SUPABASE_URL         e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY Supabase service-role secret key
 *   ADMIN_SENDER_ID      UUID of admin "bleh" — their messages are ignored
 *   CHAT_SECRET          Same as VITE_CHAT_SECRET in the NestX web app
 */

const { createClient } = require("@supabase/supabase-js");
const { webcrypto } = require("crypto");
const crypto = webcrypto;

const {
  TG_FWD_BOT_TOKEN,
  TG_CHAT_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ADMIN_SENDER_ID,
  CHAT_SECRET,
} = process.env;

if (!TG_FWD_BOT_TOKEN || !TG_CHAT_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("[TGFwd] Missing required env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Session state ─────────────────────────────────────────────────────────────
// notified: true after first notification is sent this session
// reminderTimer: setTimeout handle for 30-min reminder
// lastAdminSeenAt: timestamp of when bleh last read messages (from seen_at updates)
const session = {
  notified: false,
  reminderTimer: null,
  lastAdminSeenAt: null,
};

const REMIND_AFTER_MS = 30 * 60 * 1000; // 30 minutes
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // bleh = "online" if seen within 5 min

// ── Is admin currently online? ────────────────────────────────────────────────
function isAdminOnline() {
  if (!session.lastAdminSeenAt) return false;
  return Date.now() - session.lastAdminSeenAt < ONLINE_THRESHOLD_MS;
}

// ── Reset session (bleh read the messages) ────────────────────────────────────
function resetSession() {
  session.notified = false;
  if (session.reminderTimer) {
    clearTimeout(session.reminderTimer);
    session.reminderTimer = null;
  }
  console.log("[TGFwd] Session reset — bleh read the messages.");
}

// ── Weather fetch (wttr.in — free, no API key) ────────────────────────────────
async function getWeather() {
  try {
    const res = await fetch(
      "https://wttr.in/Ghaziabad,UP,India?format=j1",
      { headers: { "User-Agent": "curl/7.68.0" } }
    );
    if (!res.ok) throw new Error(`wttr.in status ${res.status}`);
    const data = await res.json();

    const current = data.current_condition[0];
    const area = data.nearest_area[0];
    const today = data.weather[0];

    const tempC = current.temp_C;
    const feelsC = current.FeelsLikeC;
    const desc = current.weatherDesc[0].value;
    const humidity = current.humidity;
    const windKmph = current.windspeedKmph;
    const city = area.areaName[0].value;
    const maxC = today.maxtempC;
    const minC = today.mintempC;

    return (
      `🌤 <b>Weather Update — ${city}</b>\n\n` +
      `🌡 <b>${tempC}°C</b> (feels like ${feelsC}°C)\n` +
      `☁️ ${desc}\n` +
      `📊 High <b>${maxC}°C</b> · Low <b>${minC}°C</b>\n` +
      `💧 Humidity: ${humidity}%  💨 Wind: ${windKmph} km/h`
    );
  } catch (err) {
    console.error("[TGFwd] Weather fetch failed:", err.message);
    return `🌤 <b>Weather Update — Ghaziabad</b>\n\nCould not fetch live data right now.`;
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

// ── Send notification + start 30-min reminder ─────────────────────────────────
async function notify(isReminder = false) {
  const weather = await getWeather();
  const prefix = isReminder
    ? `🔔 <b>Reminder</b> — still unread\n\n`
    : ``;
  await sendTelegram(prefix + weather);

  session.notified = true;
  if (session.reminderTimer) clearTimeout(session.reminderTimer);
  session.reminderTimer = setTimeout(async () => {
    if (session.notified && !isAdminOnline()) {
      console.log("[TGFwd] 30-min reminder firing...");
      await notify(true);
    } else {
      console.log("[TGFwd] 30-min reminder skipped — admin online or session reset.");
    }
  }, REMIND_AFTER_MS);
}

// ── Decryption ────────────────────────────────────────────────────────────────
let _keyPromise = null;
async function getKey() {
  if (_keyPromise) return _keyPromise;
  _keyPromise = (async () => {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw", enc.encode(CHAT_SECRET || "fallback"), "PBKDF2", false, ["deriveKey"]
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

// ── Realtime listeners ────────────────────────────────────────────────────────
supabase
  .channel("tg-fwd-listener")

  // New message from other user
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "messages" },
    async ({ new: row }) => {
      if (row.sender_id === ADMIN_SENDER_ID) return;

      if (isAdminOnline()) {
        console.log("[TGFwd] New message — admin online, skipping.");
        return;
      }

      if (session.notified) {
        console.log("[TGFwd] New message — already notified this session, skipping.");
        return;
      }

      console.log("[TGFwd] New message — sending first notification.");
      await notify(false);
    }
  )

  // Admin read messages (seen_at updated) → reset session
  .on(
    "postgres_changes",
    { event: "UPDATE", schema: "public", table: "messages" },
    ({ new: row }) => {
      if (row.seen_at && row.sender_id !== ADMIN_SENDER_ID) {
        session.lastAdminSeenAt = Date.now();
        resetSession();
      }
    }
  )

  .subscribe((status) => {
    console.log("[TGFwd] Realtime status:", status);
    if (status === "SUBSCRIBED") {
      console.log("[TGFwd] ✅ Listening for new messages...");
      sendTelegram("🛰 <b>System Alert</b>\nStatus update: Bot online and listening.").catch(() => {});
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
      console.error("[TGFwd] ❌ Realtime failed:", status, "— check Supabase Replication is ON for messages table");
    }
  });

console.log("Telegram Forward Bot is running...");
