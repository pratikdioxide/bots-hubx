/**
 * NestX · Drogon Lookup Bot (Node.js port)
 * Telegram bot that looks up records from your API by email or mobile number.
 *
 * ENV VARS:
 *   BOT_TOKEN          Telegram bot token from @BotFather
 *   API_BASE_URL       Your REST API base URL (ends with search=)
 *   ALLOWED_USER_IDS   Comma-separated Telegram user IDs (empty = channel members only)
 *   CHANNEL_ID         Your Telegram channel e.g. @yourchannel
 *   DATABASE_URL       Neon PostgreSQL connection string
 */

const TelegramBot = require("node-telegram-bot-api");
const { Client } = require("pg");
const { botStatuses } = require("./state");

const {
  BOT_TOKEN,
  API_BASE_URL,
  ALLOWED_USER_IDS,
  CHANNEL_ID,
  DATABASE_URL,
} = process.env;

const state = botStatuses.drogon;

if (!BOT_TOKEN || !API_BASE_URL) {
  state.status = "error";
  state.error = "Missing BOT_TOKEN or API_BASE_URL";
  console.error("[Drogon] Missing BOT_TOKEN or API_BASE_URL — bot disabled.");
  return;
}

const ALLOWED_IDS = ALLOWED_USER_IDS
  ? ALLOWED_USER_IDS.split(",").map((x) => parseInt(x.trim())).filter(Boolean)
  : [];

const RATE_LIMIT_SECONDS = 5;
const API_RETRY_ATTEMPTS = 2;
const API_RETRY_DELAY_MS = 3000;
const lastRequest = {};

// ── DB ────────────────────────────────────────────────────────────────────────
async function dbRun(sql, params = []) {
  if (!DATABASE_URL) return;
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query(sql, params);
  } catch (e) {
    console.error("[Drogon] DB error:", e.message);
  } finally {
    await client.end();
  }
}

async function dbQuery(sql, params = []) {
  if (!DATABASE_URL) return null;
  const client = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const res = await client.query(sql, params);
    return res.rows;
  } catch (e) {
    console.error("[Drogon] DB query error:", e.message);
    return null;
  } finally {
    await client.end();
  }
}

async function initDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id   BIGINT PRIMARY KEY,
      username      TEXT,
      first_name    TEXT,
      joined_at     TIMESTAMPTZ DEFAULT NOW(),
      last_seen     TIMESTAMPTZ DEFAULT NOW(),
      total_lookups INTEGER DEFAULT 0
    )
  `);
}

async function upsertUser(user) {
  await dbRun(
    `INSERT INTO users (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE
       SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, last_seen = NOW()`,
    [user.id, user.username || null, user.first_name || null]
  );
}

async function incrementLookup(userId) {
  await dbRun(
    `UPDATE users SET total_lookups = total_lookups + 1, last_seen = NOW() WHERE telegram_id = $1`,
    [userId]
  );
}

async function getStats() {
  const rows = await dbQuery(
    `SELECT COUNT(*) AS total_users, COALESCE(SUM(total_lookups),0) AS total_lookups, MAX(last_seen) AS last_active FROM users`
  );
  return rows?.[0] || {};
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function isEmail(text) {
  return text.includes("@") && text.split("@")[1]?.includes(".");
}

function isMobile(text) {
  const digits = text.replace(/[+\s-]/g, "");
  return /^\d{7,15}$/.test(digits);
}

function normalizeMobile(text) {
  const digits = text.replace(/[+\s-]/g, "");
  return digits.length === 10 ? "91" + digits : digits;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmt(v) {
  return v == null || v === "" ? "—" : escapeHtml(String(v));
}

function formatRecord(record) {
  if (!record) return "<i>(empty record)</i>";
  if (Array.isArray(record) && typeof record[0] === "string") {
    return record.map((l) => `• ${escapeHtml(l)}`).join("\n");
  }
  if (typeof record === "object" && !Array.isArray(record)) {
    return Object.entries(record)
      .map(([k, v]) => `• <b>${escapeHtml(k)}</b>: <code>${fmt(v)}</code>`)
      .join("\n");
  }
  return escapeHtml(String(record));
}

// ── API ───────────────────────────────────────────────────────────────────────
async function fetchRecord(query) {
  const url = `${API_BASE_URL}${query}`;
  for (let attempt = 1; attempt <= API_RETRY_ATTEMPTS; attempt++) {
    try {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        return [null, `❌ API error <code>${res.status}</code>. Please try again later.`];
      }
      const data = await res.json();
      return [data, null];
    } catch (e) {
      if (attempt < API_RETRY_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, API_RETRY_DELAY_MS));
        continue;
      }
      return [null, "❌ Could not reach the API. Please try again later."];
    }
  }
  return [null, "❌ API unavailable after retries."];
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function isMember(bot, userId) {
  if (!CHANNEL_ID) return true;
  try {
    const member = await bot.getChatMember(CHANNEL_ID, userId);
    return ["member", "administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

function joinKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📢 Join Channel", url: `https://t.me/${CHANNEL_ID.replace("@", "")}` }],
      [{ text: "✅ Verify Membership", callback_data: "drogon_verify" }],
    ],
  };
}

// ── Pagination helper ─────────────────────────────────────────────────────────
const userResultsCache = {};

async function sendPage(bot, chatId, msgId, records, page, query) {
  const total = records.length;
  const text =
    `✅ <b>Result ${page + 1} of ${total}</b> for <code>${escapeHtml(query)}</code>\n` +
    `${"─".repeat(30)}\n` +
    formatRecord(records[page]);

  const buttons = [];
  if (page > 0) buttons.push({ text: "⬅️ Prev", callback_data: `drogon_page:${page - 1}` });
  if (page < total - 1) buttons.push({ text: "Next ➡️", callback_data: `drogon_page:${page + 1}` });
  const reply_markup = buttons.length ? { inline_keyboard: [buttons] } : undefined;

  if (msgId) {
    await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup });
  } else {
    await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup });
  }
}

// ── Bot setup ─────────────────────────────────────────────────────────────────
(async () => {
  await initDb().catch((e) => console.error("[Drogon] DB init failed:", e.message));

  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  state.status = "online";
  console.log("[Drogon] Bot running 🐉");

  const WELCOME = (name) =>
    `👋 <b>Welcome, ${name}!</b>\n\nI'm <b>Drogon</b> — your free info bot.\n\n` +
    `📖 <b>How to use:</b>\n\nJust send an email or mobile number.\n\n` +
    `<code>user@example.com</code>\n<code>9876543210</code>\n\nCommands:\n  /help — show this guide`;

  const GUIDANCE =
    `📖 <b>How to use:</b>\n\nSend an email or mobile number and I'll fetch everything.\n\n` +
    `<code>john@example.com</code>\n<code>+919876543210</code>`;

  // /start
  bot.onText(/\/start/, async (msg) => {
    const user = msg.from;
    await upsertUser(user);
    if (ALLOWED_IDS.length && !ALLOWED_IDS.includes(user.id)) {
      if (!await isMember(bot, user.id)) {
        return bot.sendMessage(msg.chat.id,
          `🔒 <b>Access Restricted</b>\n\nYou must join ${escapeHtml(CHANNEL_ID)} to use this bot.\n\n1️⃣ Click <b>Join Channel</b>\n2️⃣ Click <b>Verify Membership</b>`,
          { parse_mode: "HTML", reply_markup: joinKeyboard() }
        );
      }
    }
    bot.sendMessage(msg.chat.id, WELCOME(escapeHtml(user.first_name || "User")), { parse_mode: "HTML" });
  });

  // /help
  bot.onText(/\/help/, async (msg) => {
    bot.sendMessage(msg.chat.id, GUIDANCE, { parse_mode: "HTML" });
  });

  // /status — admin only
  bot.onText(/\/status/, async (msg) => {
    const uid = msg.from.id;
    if (ALLOWED_IDS.length && !ALLOWED_IDS.includes(uid)) return;
    const stats = await getStats();
    bot.sendMessage(msg.chat.id,
      `🟢 <b>Drogon Status</b>\n\n` +
      `👥 <b>Total users:</b> <code>${stats.total_users || "—"}</code>\n` +
      `🔍 <b>Total lookups:</b> <code>${stats.total_lookups || "—"}</code>\n` +
      `🕓 <b>Last active:</b> <code>${stats.last_active ? new Date(stats.last_active).toUTCString() : "—"}</code>\n` +
      `🔢 <b>Session queries:</b> <code>${state.queries}</code>`,
      { parse_mode: "HTML" }
    );
  });

  // Lookup message
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const user = msg.from;
    const uid = user.id;
    await upsertUser(user);

    if (ALLOWED_IDS.length && !ALLOWED_IDS.includes(uid)) {
      if (!await isMember(bot, uid)) {
        return bot.sendMessage(msg.chat.id,
          `🔒 <b>Access Restricted</b>\n\nYou must join ${escapeHtml(CHANNEL_ID)} to use this bot.`,
          { parse_mode: "HTML", reply_markup: joinKeyboard() }
        );
      }
    }

    let query = msg.text.trim();
    if (!isEmail(query) && !isMobile(query)) {
      return bot.sendMessage(msg.chat.id,
        `⚠️ Send a valid <b>email address</b> or <b>mobile number</b>.\n\nExamples:\n<code>john@example.com</code>\n<code>+919876543210</code>`,
        { parse_mode: "HTML" }
      );
    }

    if (isMobile(query)) query = normalizeMobile(query);

    const now = Date.now() / 1000;
    if (lastRequest[uid] && now - lastRequest[uid] < RATE_LIMIT_SECONDS) {
      const wait = Math.ceil(RATE_LIMIT_SECONDS - (now - lastRequest[uid])) + 1;
      return bot.sendMessage(msg.chat.id, `⏳ Please wait <b>${wait}s</b> before the next request.`, { parse_mode: "HTML" });
    }
    lastRequest[uid] = now;

    await bot.sendChatAction(msg.chat.id, "typing");
    const [data, error] = await fetchRecord(query);

    state.queries++;
    state.last_query = new Date().toISOString();
    await incrementLookup(uid);

    if (error) return bot.sendMessage(msg.chat.id, error, { parse_mode: "HTML" });
    if (!data) return bot.sendMessage(msg.chat.id, `🔍 No record found for <code>${escapeHtml(query)}</code>.`, { parse_mode: "HTML" });

    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object") {
      userResultsCache[uid] = { records: data, query };
      await sendPage(bot, msg.chat.id, null, data, 0, query);
      return;
    }

    bot.sendMessage(msg.chat.id,
      `✅ <b>Record found</b> for <code>${escapeHtml(query)}</code>\n${"─".repeat(30)}\n${formatRecord(data)}`,
      { parse_mode: "HTML" }
    );
  });

  // Callbacks
  bot.on("callback_query", async (cq) => {
    const uid = cq.from.id;
    const data = cq.data;

    if (data === "drogon_verify") {
      await bot.answerCallbackQuery(cq.id);
      if (await isMember(bot, uid)) {
        bot.editMessageText(
          `✅ <b>Verified!</b>\n\nYou now have full access.\n\n${GUIDANCE}`,
          { chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: "HTML" }
        );
      } else {
        bot.editMessageText(
          `❌ <b>Not a member yet.</b>\n\nPlease join the channel first, then click <b>Verify</b> again.`,
          { chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: "HTML", reply_markup: joinKeyboard() }
        );
      }
      return;
    }

    if (data.startsWith("drogon_page:")) {
      await bot.answerCallbackQuery(cq.id);
      const page = parseInt(data.split(":")[1]);
      const cached = userResultsCache[uid];
      if (cached) {
        await sendPage(bot, cq.message.chat.id, cq.message.message_id, cached.records, page, cached.query);
      }
    }
  });

  bot.on("polling_error", (err) => {
    console.error("[Drogon] Polling error:", err.message);
    state.status = "error";
    state.error = err.message;
  });
})();