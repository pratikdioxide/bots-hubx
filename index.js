/**
 * NestX · Unified Bot Runner
 * Starts all 3 bots + a single HTTP health server.
 * Deploy as one Render web service — ping /health every 5 min from UptimeRobot.
 */

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { BOT_START_TIME, botStatuses } = require("./bots/state");

// ── Start all bots ────────────────────────────────────────────────────────────
require("./bots/drogon");
require("./bots/igReel");

// ── Helpers ───────────────────────────────────────────────────────────────────
function humanUptime(start) {
  const s   = Math.floor((Date.now() - start) / 1000);
  const d   = Math.floor(s / 86400);
  const h   = Math.floor((s % 86400) / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d)   parts.push(`${d}d`);
  if (h)   parts.push(`${h}h`);
  if (m)   parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(" ");
}

// ── Health + Dashboard server ─────────────────────────────────────────────────
const PORT      = process.env.PORT || 8080;
const DASHBOARD = path.join(__dirname, "public", "index.html");

const server = http.createServer((req, res) => {
  // JSON health endpoint — pinged by UptimeRobot
  if (req.url === "/health") {
    const payload = {
      status:     "ok",
      uptime:     humanUptime(BOT_START_TIME),
      started_at: new Date(BOT_START_TIME).toISOString(),
      bots:       botStatuses,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload, null, 2));
    return;
  }

  // Dashboard HTML
  if (req.url === "/" || req.url === "/dashboard") {
    try {
      const html = fs.readFileSync(DASHBOARD, "utf8");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end("Dashboard not found");
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`[NestX] Health server → http://localhost:${PORT}/health`);
  console.log(`[NestX] Dashboard    → http://localhost:${PORT}/`);
});
