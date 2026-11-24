// Builds the "Chats" list from OpenWA's chat list + address book, one row per person.
// WhatsApp now addresses most chats by a private id (…@lid) while saved contacts keep their
// phone id (…@c.us), so the same person shows up twice. Rows are merged locally — never by asking
// WhatsApp, since bulk number lookups are what gets accounts flagged.

const digits = (s) => String(s || '').replace(/\D/g, '');
// Unsaved chats are named after the number, e.g. "+91 7456 874 740".
const phoneFromName = (name) => (/^\+?[\d\s()-]{8,}$/.test(name || '') ? digits(name) : null);
const key = (name) => String(name || '').trim(); // exact: chat and contact names come from the same address book

function mergeContacts(chats, people, myPhone) {
  const rows = new Map();
  for (const c of chats) {
    if (c.kind !== 'individual') continue;
    const isPhoneId = c.id.endsWith('@c.us');
    rows.set(c.id, {
      id: c.id,
      name: c.name || null,
      number: isPhoneId ? digits(c.id) : phoneFromName(c.name), // a lid is not a phone number
      last: c.lastMessage || '',
      ts: c.timestamp || 0,
      saved: false,
    });
  }

  // The address book can list one @c.us id twice (once carrying its lid as 'number'): keep the first.
  const saved = [...new Map(people.filter((p) => p.id?.endsWith('@c.us') && !p.isBlocked).reverse().map((p) => [p.id, p])).values()];
  const nameCount = {};
  for (const p of saved) if (p.name) nameCount[key(p.name)] = (nameCount[key(p.name)] || 0) + 1;
  const lidByName = new Map();
  const lidByNumber = new Map();
  for (const r of rows.values()) {
    if (!r.id.endsWith('@lid')) continue;
    if (r.number) lidByNumber.set(r.number, r);
    else if (r.name) lidByName.set(key(r.name), r);
  }

  for (const p of saved) {
    const phone = digits(p.id); // p.number can hold a lid; the @c.us id is the real number
    const name = p.name || p.pushName || null;
    const same = rows.get(p.id);
    if (same) { same.name ||= name; same.saved ||= !!p.isMyContact; continue; }
    const byNumber = lidByNumber.get(phone);
    if (byNumber) { byNumber.saved = true; if (name && phoneFromName(byNumber.name)) byNumber.name = name; continue; }
    const twin = name && nameCount[key(name)] === 1 && lidByName.get(key(name)); // unique name only
    if (twin) { twin.number = phone; twin.saved = true; lidByName.delete(key(name)); continue; }
    if (p.isMyContact && !rows.has(p.id)) rows.set(p.id, { id: p.id, name, number: phone, last: '', ts: 0, saved: true });
  }

  for (const r of rows.values()) r.self = !!myPhone && r.number === digits(myPhone);
  return [...rows.values()].sort((a, b) => b.self - a.self || b.ts - a.ts || (a.name || '').localeCompare(b.name || ''));
}

module.exports = { mergeContacts, digits };
