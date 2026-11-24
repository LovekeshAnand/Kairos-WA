const test = require('node:test');
const assert = require('node:assert');
const { windowFor, closeWindow, catchUpSince, slim, newerVersion } = require('./sync');

test('pause windows bound buffered messages', () => {
  const open = { id: 'a', from: 1000, to: null, state: 'open' };
  const done = { id: 'b', from: 100, to: 200, state: 'done' };
  assert.equal(windowFor([done, open], 150), done);
  assert.equal(windowFor([done, open], 5000), open);
  assert.equal(windowFor([done, open], 500), null);
  assert.equal(windowFor([done], 200), null); // end is exclusive
  assert.equal(closeWindow({ ...open }, 0, 2000).state, 'done');
  assert.deepEqual(closeWindow({ ...open }, 3, 2000), { id: 'a', from: 1000, to: 2000, state: 'pending' });
});

test('catch-up never reaches past a week or before monitoring began', () => {
  const now = 10_000_000;
  assert.equal(catchUpSince(now - 60, null, null, now), now - 60);
  assert.equal(catchUpSince(now - 30 * 86400, null, null, now), now - 7 * 86400);
  assert.equal(catchUpSince(null, now - 100, null, now), now - 100);
  assert.equal(catchUpSince(now - 500, now - 100, null, now), now - 100); // switched on after the last message
  assert.equal(catchUpSince(null, null, now - 3600, now), now - 3600); // chat watched before this version
  assert.equal(catchUpSince(null, null, null, now), null);
});

test('slim keeps what filing needs', () => {
  const m = slim({ id: 'x', body: 'hi', type: 'document', media: { filename: 'a.pdf', mimetype: 'application/pdf', data: 'BIG' }, extra: 1 });
  assert.deepEqual(m.media, { filename: 'a.pdf', mimetype: 'application/pdf' });
  assert.equal(m.extra, undefined);
});

test('version compare', () => {
  assert.equal(newerVersion('1.10.0', '1.9.2'), true);
  assert.equal(newerVersion('1.0.0', '1.0.0'), false);
  assert.equal(newerVersion('0.9', '1.0.0'), false);
});
