const test = require('node:test');
const assert = require('node:assert');
const { mergeContacts } = require('./contacts');

test('one row per person: lid chats merge with their saved contact, lids never shown as numbers', () => {
  const chats = [
    { id: '104780173181082@lid', name: '@Lovekesh_Anand', kind: 'individual', timestamp: 5 },
    { id: '140574397083719@lid', name: '+91 7456 874 740', kind: 'individual', timestamp: 4 },
    { id: '117450645495828@lid', name: 'Atul Anand', kind: 'individual', timestamp: 3 },
    { id: '1203@g.us', name: 'Group', kind: 'group' },
    { id: '225297492377643@lid', name: '+919667669431', kind: 'individual' },
    { id: '257754442809360@lid', name: 'Mukul Easeinfra', kind: 'individual' },
    { id: '221641871208679@lid', name: 'Mukul EaseInfra', kind: 'individual' },
  ];
  const people = [
    { id: '918929750553@c.us', name: '@Lovekesh_Anand', number: '918929750553', isMyContact: true },
    { id: '918929750553@c.us', name: '@Lovekesh_Anand', number: '104780173181082', isMyContact: true }, // dup record carrying the lid
    { id: '917000000001@c.us', name: 'Rahul', isMyContact: true },
    { id: '917000000002@c.us', name: 'Rahul', isMyContact: true },
    { id: '919667669431@c.us', isMyContact: true },
    { id: '918920598504@c.us', name: 'Mukul Easeinfra', isMyContact: true },
    { id: '918076572954@c.us', name: 'Mukul EaseInfra', isMyContact: true },
    { id: '100059903438926@lid', number: '100059903438926', isMyContact: false },
  ];
  const rows = mergeContacts(chats, people, '918929750553');
  const me = rows.filter((r) => r.name === '@Lovekesh_Anand');
  assert.strictEqual(me.length, 1);
  assert.deepStrictEqual([me[0].id, me[0].number, me[0].self], ['104780173181082@lid', '918929750553', true]);
  assert.strictEqual(rows[0].self, true); // you are listed first
  assert.strictEqual(rows.find((r) => r.id === '140574397083719@lid').number, '9174568747' + '40');
  assert.strictEqual(rows.find((r) => r.id === '117450645495828@lid').number, null); // unknown, not the lid digits
  assert.strictEqual(rows.filter((r) => r.name === 'Rahul').length, 2); // ambiguous names are not merged
  assert.ok(!rows.some((r) => r.id.endsWith('@g.us')));
  assert.strictEqual(rows.filter((r) => r.number === '919667669431').length, 1); // merged by number
  assert.strictEqual(rows.find((r) => r.id === '257754442809360@lid').number, '918920598504'); // exact-name match
  assert.strictEqual(rows.find((r) => r.id === '221641871208679@lid').number, '918076572954');
});
