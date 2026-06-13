/**
 * NestX · Telegram Forward Bot
 * ------------------------------------
 * Smart notification logic:
 * - Sends a real weather report (configurable city) on the OTHER user's FIRST message
 * - Stays silent for all follow-up messages in the same session
 * - Skips entirely if admin "bleh" is currently online (seen messages recently)
 * - Resends weather report every 30 min if bleh still hasn't read the messages
 * - Resets when bleh reads (seen_at updated) → next conversation starts fresh
 * - Session state is persisted in public.bot_session so a Render restart
 *   won't double-notify.
 *
 * ENV VARS:
 *   TG_FWD_BOT_TOKEN     Telegram bot token (from @BotFather)
 *   TG_CHAT_ID           Bleh's personal Telegram chat ID
 *   SUPABASE_URL         e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY Supabase service-role secret key
 *   ADMIN_SENDER_ID      UUID of admin "bleh" — their messages are ignored
 *   LOCATION             Optional. Weather city, e.g. "Ghaziabad,UP,India".
 *                        Defaults to "Ghaziabad,UP,India".
 */

const { createClient } = require("@supabase/supabase-js");

const {
  TG_FWD_BOT_TOKEN,
  TG_CHAT_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ADMIN_SENDER_ID,
  LOCATION,
} = process.env;

if (!TG_FWD_BOT_TOKEN || !TG_CHAT_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("[TGFwd] Missing required env vars.");
  process.exit(1);
}

const WEATHER_LOCATION = LOCATION || "Ghaziabad,UP,India";
const SESSION_KEY = "tg-forward:default";
const REMIND_AFTER_MS = 30 * 60 * 1000;        // 30 minutes
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000;     // bleh = "online" if seen within 5 min

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── In-memory mirror of the persisted session ────────────────────────────────
const session = {
  notified: false,
  reminderTimer: null,
  lastAdminSeenAt: null,
};

// ── Persistence helpers ──────────────────────────────────────────────────────
async function loadSession() {
  const { data, error } = await supabase
    .from("bot_session")
    .select("notified, last_admin_seen_at")
    .eq("key", SESSION_KEY)
    .maybeSingle();
  if (error) {
    console.error("[TGFwd] loadSession error:", error.message);
    return;
  }
  if (data) {
    session.notified = !!data.notified;
    session.lastAdminSeenAt = data.last_admin_seen_at ? new Date(data.last_admin_seen_at).getTime() : null;
    console.log("[TGFwd] Restored session — notified:", session.notified, "lastAdminSeenAt:", session.lastAdminSeenAt);
  }
}

async function persistSession(patch) {
  const row = {
    key: SESSION_KEY,
    notified: session.notified,
    last_admin_seen_at: session.lastAdminSeenAt ? new Date(session.lastAdminSeenAt).toISOString() : null,
    updated_at: new Date().toISOString(),
    ...patch,
  };
  const { error } = await supabase.from("bot_session").upsert(row, { onConflict: "key" });
  if (error) console.error("[TGFwd] persistSession error:", error.message);
}

function isAdminOnline() {
  if (!session.lastAdminSeenAt) return false;
  return Date.now() - session.lastAdminSeenAt < ONLINE_THRESHOLD_MS;
}

async function resetSession() {
  session.notified = false;
  if (session.reminderTimer) {
    clearTimeout(session.reminderTimer);
    session.reminderTimer = null;
  }
  await persistSession({});
  console.log("[TGFwd] Session reset — bleh read the messages.");
}

// ── Weather (wttr.in — free, no API key) ─────────────────────────────────────
async function getWeather() {
  try {
    const res = await fetch(
      `https://wttr.in/${encodeURIComponent(WEATHER_LOCATION)}?format=j1`,
      { headers: { "User-Agent": "curl/7.68.0" } }
    );
    if (!res.ok) throw new Error(`wttr.in status ${res.status}`);
    const data = await res.json();

    const current = data.current_condition[0];
    const area = data.nearest_area[0];
    const today = data.weather[0];

    const city = area.areaName[0].value;
    return (
      `🌤 <b>Weather Update — ${city}</b>\n\n` +
      `🌡 <b>${current.temp_C}°C</b> (feels like ${current.FeelsLikeC}°C)\n` +
      `☁️ ${current.weatherDesc[0].value}\n` +
      `📊 High <b>${today.maxtempC}°C</b> · Low <b>${today.mintempC}°C</b>\n` +
      `💧 Humidity: ${current.humidity}%  💨 Wind: ${current.windspeedKmph} km/h`
    );
  } catch (err) {
    console.error("[TGFwd] Weather fetch failed:", err.message);
    return `🌤 <b>Weather Update — ${WEATHER_LOCATION}</b>\n\nCould not fetch live data right now.`;
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
  if (!res.ok) console.error("[TGFwd] Telegram API error:", await res.text());
}

// ── Notification + 30-min reminder ────────────────────────────────────────────
async function notify(isReminder = false) {
  const weather = await getWeather();
  const prefix = isReminder ? `🔔 <b>Reminder</b> — still unread\n\n` : ``;
  await sendTelegram(prefix + weather);

  session.notified = true;
  await persistSession({});

  if (session.reminderTimer) clearTimeout(session.reminderTimer);
  session.reminderTimer = setTimeout(async () => {
    if (session.notified && !isAdminOnline()) {
      console.log("[TGFwd] 30-min reminder firing...");
      await notify(true);
    } else {
      console.log("[TGFwd] 30-min reminder skipped.");
    }
  }, REMIND_AFTER_MS);
}

// ── Realtime listeners ────────────────────────────────────────────────────────
async function start() {
  await loadSession();

  supabase
    .channel("tg-fwd-listener")

    // New message from the other user
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      async ({ new: row }) => {
        if (row.sender_id === ADMIN_SENDER_ID) return;
        if (isAdminOnline()) { console.log("[TGFwd] Skip — admin online."); return; }
        if (session.notified) { console.log("[TGFwd] Skip — already notified."); return; }

        console.log("[TGFwd] Notifying with weather report...");
        await notify(false);
      }
    )

    // Admin read messages (seen_at updated) → reset session
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "messages" },
      async ({ new: row }) => {
        if (row.seen_at && row.sender_id !== ADMIN_SENDER_ID) {
          session.lastAdminSeenAt = Date.now();
          await resetSession();
        }
      }
    )

    .subscribe((status) => {
      console.log("[TGFwd] Realtime status:", status);
      if (status === "SUBSCRIBED") {
        console.log("[TGFwd] ✅ Listening for new messages...");
        sendTelegram("🛰 <b>System Alert</b>\nStatus update: Bot online and listening.").catch(() => {});
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.error("[TGFwd] ❌ Realtime failed:", status);
      }
    });

  console.log("Telegram Forward Bot is running... LOCATION =", WEATHER_LOCATION);
}

start().catch((e) => { console.error("[TGFwd] Fatal:", e); process.exit(1); });
