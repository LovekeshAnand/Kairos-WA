// Pure helpers for catch-up and pause windows (kept apart so they can be tested without OpenWA).

const WEEK = 7 * 86400;

// The pause window a message timestamp (ms) falls in, if any. Windows: { from, to|null, state }.
function windowFor(pauses, tsMs) {
  return pauses.find((w) => tsMs >= w.from && (w.to == null || tsMs < w.to)) || null;
}

// Closes an open window: it needs a decision only if messages were buffered during it.
function closeWindow(w, buffered, now = Date.now()) {
  w.to = now;
  w.state = buffered ? 'pending' : 'done';
  return w;
}

// Unix seconds to fetch history from for one chat, or null when there is no safe starting point
// (never backfills further than a week, nor before the chat was switched on).
function catchUpSince(lastSeen, monitoredSince, prevAlive, now) {
  const base = Math.max(lastSeen || 0, monitoredSince || 0) || prevAlive;
  if (!base) return null;
  return Math.max(base, now - WEEK);
}

// What is worth keeping of a message for later filing (buffer, outbox).
function slim(m) {
  const { id, chatId, from, body, type, timestamp, fromMe, kind, senderPhone, media, order, product } = m;
  return {
    id, chatId, from, body, type, timestamp, fromMe, kind, senderPhone,
    media: media && { filename: media.filename, mimetype: media.mimetype },
    order: order && { orderId: order.orderId },
    product,
  };
}

// "1.10.0" > "1.9.2"
function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

module.exports = { windowFor, closeWindow, catchUpSince, slim, newerVersion };
