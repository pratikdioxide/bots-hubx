/**
 * Shared state across all bots.
 * Each bot writes its own status here; the health server reads it.
 */

const BOT_START_TIME = Date.now();

const botStatuses = {
  drogon: {
    name: "Drogon Lookup Bot",
    status: "starting",
    queries: 0,
    last_query: null,
    error: null,
  },
  igReel: {
    name: "Instagram Reel Bot",
    status: "starting",
    posts: 0,
    last_post: null,
    error: null,
  },
  tgForward: {
    name: "TG Forward Bot",
    status: "starting",
    forwarded: 0,
    last_forwarded: null,
    error: null,
  },
};

module.exports = { BOT_START_TIME, botStatuses };