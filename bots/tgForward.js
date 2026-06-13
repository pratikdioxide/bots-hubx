/**
 * NestX · Telegram Forward Bot (v2 — diagnostic build)
 * ----------------------------------------------------
 * What's new vs v1:
 *  - Sends a self-test on startup (weather report + env diagnostics) so you
 *    can immediately tell whether the bot is actually running on Render.
 *  - Uses public.user_presence as the source of truth for "is bleh online"
 *    instead of relying on seen_at updates the bot might have missed during
 *    a restart.
 *  - Polls Telegram for commands so you can probe state from your phone:
 *        /ping     — replies "pong" + uptime
 *        /status   — env vars OK?, session state, last admin presence
 *        /test     — fakes the "other user sent a msg" flow and notifies you
 *        /weather  — pulls the live weather report on demand
 *        /reset    — clears session.notified so the next real msg notifies
 *  - Verbose console logging on every realtime event so Render logs explain
 *    exactly why a notification did or didn't fire.
 *
 * ENV (unchanged):
 *   TG_FWD_BOT_TOKEN, TG_CHAT_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY,
 *   ADMIN_SENDER_ID, LOCATION (optional), CHAT_SECRET (optional, for decrypt)
 */

const { createClient } = require("@supabase/supabase-js");
const TelegramBot = require("node-telegram-bot-api");
const crypto = require("crypto");

const {
  TG_FWD_BOT_TOKEN,
  TG_CHAT_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ADMIN_SENDER_ID,
  LOCATION,
  CHAT_SECRET,
  ADMIN_DISPLAY_NAME, // optional — defaults to "Bleh"
} = process.env;

const missing = [];
if (!TG_FWD_BOT_TOKEN) missing.push("TG_FWD_BOT_TOKEN");
if (!TG_CHAT_ID) missing.push("TG_CHAT_ID");
if (!SUPABASE_URL) missing.push("SUPABASE_URL");
if (!SUPABASE_SERVICE_KEY) missing.push("SUPABASE_SERVICE_KEY");
if (!ADMIN_SENDER_ID) missing.push("ADMIN_SENDER_ID");
if (missing.length) {
  console.error("[TGFwd] FATAL — missing env:", missing.join(", "));
  process.exit(1);
}

const WEATHER_LOCATION = LOCATION || "Ghaziabad,UP,India";
const ADMIN_NAME = ADMIN_DISPLAY_NAME || "Bleh";
const SESSION_KEY = "tg-forward:default";
const REMIND_AFTER_MS = 30 * 60 * 1000;
const ONLINE_THRESHOLD_MS = 2 * 60 * 1000; // 2 min — presence row updates often

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const bot = new TelegramBot(TG_FWD_BOT_TOKEN, { polling: true });
const startedAt = Date.now();
const session = { notified: false, reminderTimer: null };

// ── Decryption (matches src/lib/crypto.ts) ──────────────────────────────
async function decryptContent(content) {
  if (!content || !CHAT_SECRET || !content.startsWith("enc:")) return content;
  try {
    const buf = Buffer.from(content.slice(4), "base64");
    const iv = buf.subarray(0, 12);
    const data = buf.subarray(12);
    const ciphertext = data.subarray(0, data.length - 16);
    const tag = data.subarray(data.length - 16);

    const keyMaterial = crypto.createHash("sha256"); // PBKDF2 below for parity
    void keyMaterial;
    const key = crypto.pbkdf2Sync(
      CHAT_SECRET,
      "nest-chat-salt-v1",
      100_000,
      32,
      "sha256",
    );
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (e) {
    console.error("[TGFwd] decrypt failed:", e.message);
    return "[encrypted]";
  }
}

function previewFor(row) {
  if (row.file_type === "image") return "📷 sent a photo";
  if (row.file_type === "video") return "🎥 sent a video";
  if (row.file_type === "audio") return "🎤 sent voice";
  if (row.file_type === "instagram") return "📸 sent an Instagram reel";
  if (row.file_type) return `📎 sent ${row.file_type}`;
  return null;
}

// ── Session persistence ─────────────────────────────────────────────────
async function loadSession() {
  const { data, error } = await supabase
    .from("bot_session").select("notified").eq("key", SESSION_KEY).maybeSingle();
  if (error) { console.error("[TGFwd] loadSession:", error.message); return; }
  if (data) { session.notified = !!data.notified; console.log("[TGFwd] restored notified =", session.notified); }
}
async function saveSession() {
  const { error } = await supabase.from("bot_session").upsert(
    { key: SESSION_KEY, notified: session.notified, updated_at: new Date().toISOString() },
    { onConflict: "key" },
  );
  if (error) console.error("[TGFwd] saveSession:", error.message);
}

// ── Presence check (uses public.user_presence) ──────────────────────────
async function isAdminOnline() {
  const { data, error } = await supabase
    .from("user_presence")
    .select("is_online, last_seen_at")
    .eq("user_name", ADMIN_NAME)
    .maybeSingle();
  if (error) { console.error("[TGFwd] presence:", error.message); return false; }
  if (!data) return false;
  const fresh = data.last_seen_at && (Date.now() - new Date(data.last_seen_at).getTime() < ONLINE_THRESHOLD_MS);
  return !!(data.is_online && fresh);
}

// ── Weather ─────────────────────────────────────────────────────────────
async function getWeather() {
  try {
    const r = await fetch(`https://wttr.in/${encodeURIComponent(WEATHER_LOCATION)}?format=j1`, {
      headers: { "User-Agent": "curl/7.68.0" },
    });
    if (!r.ok) throw new Error("wttr " + r.status);
    const d = await r.json();
    const c = d.current_condition[0], a = d.nearest_area[0], t = d.weather[0];
    return (
      `🌤 <b>Weather Update — ${a.areaName[0].value}</b>\n\n` +
      `🌡 <b>${c.temp_C}°C</b> (feels ${c.FeelsLikeC}°C)\n` +
      `☁️ ${c.weatherDesc[0].value}\n` +
      `📊 High <b>${t.maxtempC}°C</b> · Low <b>${t.mintempC}°C</b>\n` +
      `💧 ${c.humidity}%  💨 ${c.windspeedKmph} km/h`
    );
  } catch (e) {
    console.error("[TGFwd] weather fail:", e.message);
    return `🌤 <b>Weather Update — ${WEATHER_LOCATION}</b>\n(couldn't fetch live data)`;
  }
}

async function tg(text) {
  try { await bot.sendMessage(TG_CHAT_ID, text, { parse_mode: "HTML" }); }
  catch (e) { console.error("[TGFwd] tg send fail:", e.message); }
}

// ── Notify ──────────────────────────────────────────────────────────────
async function notify({ reminder = false, preview = null } = {}) {
  const w = await getWeather();
  const head = reminder ? "🔔 <b>Reminder — still unread</b>\n\n" : "";
  const tail = preview ? `\n\n<i>(${preview})</i>` : "";
  await tg(head + w + tail);
  session.notified = true;
  await saveSession();
  if (session.reminderTimer) clearTimeout(session.reminderTimer);
  session.reminderTimer = setTimeout(async () => {
    if (session.notified && !(await isAdminOnline())) {
      console.log("[TGFwd] 30-min reminder firing");
      await notify({ reminder: true });
    } else {
      console.log("[TGFwd] 30-min reminder skipped (read or admin online)");
    }
  }, REMIND_AFTER_MS);
}

async function resetSession(reason = "manual") {
  session.notified = false;
  if (session.reminderTimer) { clearTimeout(session.reminderTimer); session.reminderTimer = null; }
  await saveSession();
  console.log("[TGFwd] session reset —", reason);
}

// ── Telegram commands ───────────────────────────────────────────────────
bot.onText(/^\/ping/, (msg) => {
  if (String(msg.chat.id) !== String(TG_CHAT_ID)) return;
  const up = Math.floor((Date.now() - startedAt) / 1000);
  bot.sendMessage(msg.chat.id, `🏓 pong · uptime ${up}s`);
});


bot.onText(/^\/test/, async (msg) => {
  if (String(msg.chat.id) !== String(TG_CHAT_ID)) return;
  await bot.sendMessage(msg.chat.id, "🧪 Forcing a notification…");
  session.notified = false; // pretend session is fresh
  await notify({ preview: "test trigger" });
});

bot.onText(/^\/weather/, async (msg) => {
  if (String(msg.chat.id) !== String(TG_CHAT_ID)) return;
  await tg(await getWeather());
});

bot.onText(/^\/reset/, async (msg) => {
  if (String(msg.chat.id) !== String(TG_CHAT_ID)) return;
  await resetSession("via /reset");
  bot.sendMessage(msg.chat.id, "✅ session cleared");
});

// ── Realtime listeners ──────────────────────────────────────────────────
async function start() {
  await loadSession();

  supabase
    .channel("tg-fwd")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" },
      async ({ new: row }) => {
        console.log("[TGFwd] INSERT from", row.sender_id?.slice(0, 8), "file_type:", row.file_type);
        if (row.sender_id === ADMIN_SENDER_ID) { console.log("  → skip: from admin"); return; }
        if (await isAdminOnline())             { console.log("  → skip: admin online"); return; }
        if (session.notified)                  { console.log("  → skip: already notified"); return; }
        const plain = await decryptContent(row.content);
        const preview = previewFor(row) || (plain ? `"${plain.slice(0, 80)}"` : "new message");
        console.log("  → NOTIFY:", preview);
        await notify({ preview });
      })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" },
      async ({ new: row, old }) => {
        if (row.seen_at && !old?.seen_at && row.sender_id !== ADMIN_SENDER_ID) {
          console.log("[TGFwd] admin read messages → reset");
          await resetSession("admin read");
        }
      })
    .subscribe(async (status) => {
      console.log("[TGFwd] realtime:", status);
      if (status === "SUBSCRIBED") {
        console.log("[TGFwd] ✅ listening on", WEATHER_LOCATION);
        // ── SELF-TEST on every startup ────────────────────────────────
        const online = await isAdminOnline();
        await tg(
          `🛰 <b>Bot online (self-test)</b>\n\n` +
          `Location: <code>${WEATHER_LOCATION}</code>\n` +
          `Admin (${ADMIN_NAME}) online right now: <b>${online ? "YES" : "no"}</b>\n` +
          `Restored notified flag: <b>${session.notified}</b>\n\n` +
          `Sending live weather to confirm wttr.in works…`,
        );
        await tg(await getWeather());
        await tg(
          `Commands:\n` +
          `/ping · /test · /weather · /reset`,
        );
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        await tg(`❌ Realtime failed: <code>${status}</code> — enable Replication for public.messages.`);
      }
    });
}

start().catch((e) => { console.error("[TGFwd] fatal:", e); process.exit(1); });
