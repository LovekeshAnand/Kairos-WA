// Decides what an inbound DM is. Precise keyword rules first; text they can't settle is matched
// by the Epsilon embedding model against examples.js (nearest neighbours). Titles and dates are
// plain code.
const EXAMPLES = require('./examples');

const LABELS = ['noise', 'meeting', 'order', 'important'];

const DROP_TYPES = new Set(['sticker', 'reaction', 'revoked', 'call', 'audio', 'voice', 'ptt', 'location', 'contact', 'poll', 'unknown', 'masked']);
const SMALL_TALK = new Set(('ok okay okk k kk hmm hm ya yes yeah yep no nope sure done cool nice great fine thanks thank thx ty you u ' +
  'welcome hi hello hey hii gm gn good morning night evening afternoon lol haha hahaha lmao bro bhai dear ji acha accha theek thik hai haan ' +
  'han nahi shukriya dhanyavad noted received got it alright see bye tc take care').split(' '));

const RE = {
  otp: /\b(otp|one[- ]time|verification code|passcode)\b|\bcode\b.*\b\d{4,8}\b|\b\d{4,8}\b.*\bcode\b/i,
  meeting: /\b(meet(ing)?|call me|call karo|call kar|(re)?schedul\w*|appointment|catch ?up|zoom|google meet|meet\.google|teams call|calendly|baje|milte|milna|mil sakte|available (at|on|tomorrow|today)|free (at|on|tomorrow|today)|slot|our call|a call|quick call)\b/i,
  order: /\b(order|orders|qty|quantity|pcs|pieces|units|dispatch|deliver(y|ed)?|purchase|po|buy|kg|boxes|cartons?|dozen|cart|parcel|bhej dena|send me \d+|book (it|this))\b/i,
  important: /\b(price|pricing|quote|quotation|invoice|bill|gst|payment|pay|paid|due|deadline|urgent|asap|contract|proposal|discount|rate|cost|refund|issue|problem|complaint|broke|broken|damaged|defect\w*)\b/i,
  question: /\?/,
  docImage: /\b(invoice|bill|receipt|quotation|quote|po|purchase order|statement|challan|contract)\b/i,
};

function isSmallTalk(text) {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
  if (!t) return true; // emoji / punctuation only
  const words = t.split(/\s+/);
  return words.length <= 6 && words.every((w) => SMALL_TALK.has(w));
}

// Keyword hits are precise, so they decide outright. null = rules can't tell.
function ruleLabel(text) {
  if (RE.meeting.test(text)) return 'meeting';
  if (RE.order.test(text)) return 'order';
  if (RE.important.test(text)) return 'important';
  return null;
}

// k-nearest-neighbour vote over the example bank. embed: async (texts) => unit vectors.
let bank = null;
async function knnLabel(text, embed, k = 3) {
  if (!bank) {
    const entries = Object.entries(EXAMPLES).flatMap(([label, xs]) => xs.map((x) => [label, x]));
    const vecs = await embed(entries.map((e) => e[1]));
    bank = entries.map(([label], i) => ({ label, v: vecs[i] }));
  }
  const [v] = await embed([text]);
  const top = bank.map((e) => ({ label: e.label, s: e.v.reduce((acc, x, i) => acc + x * v[i], 0) })).sort((a, b) => b.s - a.s).slice(0, k);
  const votes = {};
  for (const t of top) votes[t.label] = (votes[t.label] || 0) + t.s;
  return Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
}

function title(text, fallback) {
  const line = (text || '').split('\n').map((s) => s.trim()).find(Boolean) || fallback;
  return line.length > 90 ? line.slice(0, 87) + '…' : line;
}

// msg: OpenWA message.received data. embed: Epsilon's embed(), or null when it isn't installed.
async function classify(msg, embed) {
  const type = msg.type || 'text';
  const text = (msg.body || '').trim();

  if (DROP_TYPES.has(type)) return { kind: 'noise', reason: type };
  if (type === 'document') return { kind: 'document', title: title(text, msg.media?.filename || 'Document') };
  if (type === 'order') return { kind: 'order', title: title(text, 'WhatsApp catalog order'), orderId: msg.order?.orderId };
  if (type === 'product') return { kind: 'product', title: msg.product?.title || title(text, 'Shared product'), product: msg.product };
  if (type === 'image' || type === 'video') {
    if (!text) return { kind: 'noise', reason: 'uncaptioned media' };
    if (RE.docImage.test(text)) return { kind: 'document', title: title(text, 'Image') };
  }

  if (!text || isSmallTalk(text)) return { kind: 'noise', reason: 'small talk' };
  if (RE.otp.test(text)) return { kind: 'noise', reason: 'otp' };

  const fallback = RE.question.test(text) ? 'important' : 'noise'; // no model: keep questions, drop the rest
  let label = ruleLabel(text);
  if (!label && embed) label = await knnLabel(text, embed).catch(() => fallback);
  if (!LABELS.includes(label)) label = fallback;
  if (label === 'noise') return { kind: 'noise', reason: embed ? 'epsilon' : 'rules' };
  return { kind: label, title: title(text, label), when: label === 'meeting' ? parseWhen(text) : null };
}

// --- tiny date parser for meeting requests --------------------------------------------------

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ALIASES = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };

function pad(n) { return String(n).padStart(2, '0'); }
function localIso(d, withTime) {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!withTime) return date;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

// Returns "YYYY-MM-DD", a local ISO datetime, or null.
function parseWhen(text, now = new Date()) {
  const t = text.toLowerCase();
  const d = new Date(now);
  let dayFound = false;

  if (/\b(day after tomorrow|parso|parson)\b/.test(t)) { d.setDate(d.getDate() + 2); dayFound = true; }
  else if (/\b(tomorrow|tmrw|tmr|kal)\b/.test(t)) { d.setDate(d.getDate() + 1); dayFound = true; }
  else if (/\b(today|tonight|aaj)\b/.test(t)) dayFound = true;
  else {
    const m = t.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)\b/);
    if (m) {
      const target = DAYS.includes(m[1]) ? DAYS.indexOf(m[1]) : DAY_ALIASES[m[1]];
      d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7 || 7));
      dayFound = true;
    }
  }

  const tm = t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|baje)\b/) || t.match(/\bat\s+(\d{1,2})(?:[:.](\d{2}))?\b/) || t.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (!tm && !dayFound) return null;
  if (!tm) return localIso(d, false);

  let h = Number(tm[1]);
  const min = Number(tm[2] || 0);
  const mer = tm[3];
  if (h > 23 || min > 59) return dayFound ? localIso(d, false) : null;
  if (mer === 'pm' && h < 12) h += 12;
  else if (mer === 'am' && h === 12) h = 0;
  else if (mer !== 'am' && mer !== 'pm' && h >= 1 && h <= 7) h += 12; // "4 baje" / "at 4" means afternoon
  if (/\b(tonight|raat|evening|shaam)\b/.test(t) && h < 12) h += 12;
  d.setHours(h, min, 0, 0);
  if (!dayFound && d < now) d.setDate(d.getDate() + 1); // "at 3pm" after 3pm means tomorrow
  return localIso(d, true);
}

module.exports = { classify, parseWhen, isSmallTalk };
