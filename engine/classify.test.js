const test = require('node:test');
const assert = require('node:assert');
const { classify, parseWhen } = require('./classify');

const kind = async (body, type = 'text', extra = {}) => (await classify({ body, type, ...extra }, null)).kind;

test('noise never gets logged', async () => {
  for (const s of ['ok', 'k', 'gm', 'good morning', 'thanks bro', 'lol', '👍', 'Your OTP is 849201 for verification.', 'haan theek hai'])
    assert.strictEqual(await kind(s), 'noise', s);
  assert.strictEqual(await kind('', 'sticker'), 'noise');
  assert.strictEqual(await kind('', 'image'), 'noise');
});

test('actionable messages are kept', async () => {
  assert.strictEqual(await kind('Kal 4 baje meeting rakh sakte hai to discuss project deliverables?'), 'meeting');
  assert.strictEqual(await kind('Can we hop on a google meet friday at 11am'), 'meeting');
  assert.strictEqual(await kind('Please send 20 boxes of the blue variant by Monday'), 'order');
  assert.strictEqual(await kind('Can you please share the invoice for August retainer?'), 'important');
  assert.strictEqual(await kind('', 'document', { media: { filename: 'po.pdf' } }), 'document');
  assert.strictEqual(await kind('August invoice attached', 'image'), 'document');
});

test('keyword rules beat the model; model decides the rest', async () => {
  // Fake embedder: every text maps to the same vector, so kNN returns the first label in the bank.
  const flat = async (texts) => texts.map(() => [1, 0]);
  assert.strictEqual((await classify({ body: 'can we schedule a meeting', type: 'text' }, flat)).kind, 'meeting');
  assert.strictEqual((await classify({ body: 'kya scene hai aaj', type: 'text' }, flat)).kind, 'meeting'); // first bank label
  assert.strictEqual((await classify({ body: 'how are you doing?', type: 'text' }, null)).kind, 'important'); // no model: keep questions
});

test('parseWhen understands common phrasings', () => {
  const now = new Date(2026, 9, 16, 10, 0); // Fri 16 Oct 2026, 10:00 local
  assert.match(parseWhen('kal 4 baje', now), /^2026-10-17T16:00:00/);
  assert.match(parseWhen('tomorrow at 10:30 am', now), /^2026-10-17T10:30:00/);
  assert.strictEqual(parseWhen('monday works?', now), '2026-10-19');
  assert.match(parseWhen('at 9 am', now), /^2026-10-17T09:00:00/);
  assert.match(parseWhen('today 3pm', now), /^2026-10-16T15:00:00/);
  assert.strictEqual(parseWhen('lets meet sometime', now), null);
});
