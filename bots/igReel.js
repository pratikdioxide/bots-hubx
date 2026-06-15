/**
 * NestX · Instagram Reel → Chat Bot
 * ------------------------------------
 * You send an Instagram reel/post URL to THIS Telegram bot.
 * The bot inserts it into the Supabase messages table as admin "bleh".
 * Nothing appears in the admin panel — all config is via env vars.
 *
 * Deploy on Render (free tier) as a background worker.
 * Ping every 5 min from UptimeRobot to keep it alive.
 *
 * ENV VARS (set in Render dashboard):
 *   TG_IG_BOT_TOKEN      Telegram bot token from @BotFather
 *   ADMIN_TG_USER_ID     Your personal Telegram user ID (get from @userinfobot)
 *   SUPABASE_URL         e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY Supabase service-role secret key (Settings → API)
 *   ADMIN_SENDER_ID      UUID of the "bleh" user row in your auth.users table
 *
 * Install deps: npm install node-telegram-bot-api @supabase/supabase-js
 */

const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");

const {
  TG_IG_BOT_TOKEN,
  ADMIN_TG_USER_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ADMIN_SENDER_ID,
} = process.env;

if (!TG_IG_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ADMIN_SENDER_ID) {
  console.error("Missing required env vars. Check TG_IG_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_SENDER_ID.");
  process.exit(1);
}

const bot = new TelegramBot(TG_IG_BOT_TOKEN, { polling: true });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const ALLOWED_TG_ID = Number(ADMIN_TG_USER_ID);

const ANY_URL_RE = /https?:\/\/[^\s]+/i;

bot.on("message", async (msg) => {
  const tgId = msg.from?.id;

  if (tgId !== ALLOWED_TG_ID) {
    bot.sendMessage(msg.chat.id, "⛔ Unauthorized.");
    return;
  }

  const text = (msg.text || "").trim();

  if (!text) {
    bot.sendMessage(msg.chat.id, "Send me any URL or text to post to the chat.");
    return;
  }

  const match = text.match(ANY_URL_RE);
  const url = match ? match[0] : text;

  const { error } = await supabase.from("messages").insert({
    sender_id: ADMIN_SENDER_ID,
    content: url,
    reply_to_id: null,
    file_type: "instagram",
  });

  if (error) {
    console.error("Supabase insert error:", error);
    bot.sendMessage(msg.chat.id, `❌ Failed: ${error.message}`);
  } else {
    bot.sendMessage(msg.chat.id, "Error");
  }
});

bot.on("polling_error", (err) => console.error("Polling error:", err.message));

console.log("Instagram Reel Bot is running...");
