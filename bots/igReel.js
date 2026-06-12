/**
 * NestX · Instagram Reel → Chat Bot
 * You send an Instagram reel/post URL to this Telegram bot.
 * It inserts the URL into the Supabase messages table as admin.
 *
 * ENV VARS:
 *   TG_IG_BOT_TOKEN      Telegram bot token from @BotFather
 *   ADMIN_TG_USER_ID     Your personal Telegram user ID
 *   SUPABASE_URL         e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY Supabase service-role secret key
 *   ADMIN_SENDER_ID      UUID of the admin user in your auth.users table
 */

const TelegramBot = require("node-telegram-bot-api");
const { createClient } = require("@supabase/supabase-js");
const { botStatuses } = require("./state");

const {
  TG_IG_BOT_TOKEN,
  ADMIN_TG_USER_ID,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ADMIN_SENDER_ID,
} = process.env;

const state = botStatuses.igReel;

if (!TG_IG_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ADMIN_SENDER_ID) {
  state.status = "error";
  state.error = "Missing required env vars";
  console.error("[IGReel] Missing required env vars — bot disabled.");
  return;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const ALLOWED_TG_ID = Number(ADMIN_TG_USER_ID);
const IG_URL_RE = /https?:\/\/(www\.)?instagram\.com\/(reel|p|tv)\/[\w-]+\/?/i;

const bot = new TelegramBot(TG_IG_BOT_TOKEN, { polling: true });

state.status = "online";
console.log("[IGReel] Bot running 📸");

bot.on("message", async (msg) => {
  const tgId = msg.from?.id;

  if (tgId !== ALLOWED_TG_ID) {
    bot.sendMessage(msg.chat.id, "⛔ Unauthorized.");
    return;
  }

  const text = (msg.text || "").trim();

  if (text === "/status") {
    bot.sendMessage(msg.chat.id,
      `📸 <b>IG Reel Bot</b>\n\n🟢 Online\n📤 Posts sent: <code>${state.posts}</code>\n🕓 Last post: <code>${state.last_post || "—"}</code>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const match = text.match(IG_URL_RE);
  if (!match) {
    bot.sendMessage(msg.chat.id, "Send me an Instagram reel or post URL (must contain /reel/, /p/, or /tv/).");
    return;
  }

  const url = match[0];
  const { error } = await supabase.from("messages").insert({
    sender_id: ADMIN_SENDER_ID,
    content: url,
    reply_to_id: null,
    file_type: null,
  });

  if (error) {
    console.error("[IGReel] Supabase insert error:", error);
    bot.sendMessage(msg.chat.id, `❌ Failed to post: ${error.message}`);
  } else {
    state.posts++;
    state.last_post = new Date().toISOString();
    bot.sendMessage(msg.chat.id, "✅ Reel posted to the chat.");
  }
});

bot.on("polling_error", (err) => {
  console.error("[IGReel] Polling error:", err.message);
  state.status = "error";
  state.error = err.message;
});