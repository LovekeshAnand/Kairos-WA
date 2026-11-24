const test = require('node:test');
const assert = require('node:assert');
const { assertReadOnly } = require('./openwa');

test('read-only guard: lifecycle allowed, anything that acts on WhatsApp blocked', () => {
  for (const [m, p] of [['GET', '/api/sessions/s/chats'], ['POST', '/api/sessions'], ['POST', '/api/sessions/s/start'], ['POST', '/api/sessions/s/webhooks'], ['DELETE', '/api/sessions/s/webhooks/w']])
    assert.doesNotThrow(() => assertReadOnly(m, p), p);
  for (const p of ['/api/sessions/s/messages/send-text', '/api/sessions/s/chats/read', '/api/sessions/s/presence', '/api/sessions/s/messages/react', '/api/sessions/s/chats/typing', '/api/sessions/s/messages/send-bulk'])
    assert.throws(() => assertReadOnly('POST', p), p);
});
