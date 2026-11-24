// Notion side: creates the four Kairos databases under a page the user picks, then files
// events into them. Meetings, documents and notes land on the person's page as a timeline.
const { Client } = require('@notionhq/client');

const txt = (s) => [{ type: 'text', text: { content: String(s ?? '').slice(0, 1990) } }];
const opts = (names, colors) => ({ options: names.map((name, i) => ({ name, color: colors[i % colors.length] })) });

const PERSON = {
  Name: { title: {} },
  Phone: { phone_number: {} },
  'WhatsApp ID': { rich_text: {} },
  'Last Activity': { date: {} },
  'Meeting Request': { rich_text: {} },
  'Meeting Date': { date: {} },
  Documents: { number: { format: 'number' } },
  Added: { created_time: {} },
};

function schemas(contactsDs, productsDs) {
  return {
    contacts: { title: 'Contacts', emoji: '🐈‍⬛', properties: { ...PERSON, Tags: { multi_select: opts(['Lead', 'Customer', 'Supplier', 'Partner'], ['orange', 'green', 'blue', 'purple']) } } },
    employees: { title: 'Employees', emoji: '🧑‍💼', properties: { ...PERSON, Role: { rich_text: {} }, Department: { select: opts(['Sales', 'Operations', 'Finance', 'Support'], ['orange', 'blue', 'green', 'gray']) } } },
    products: {
      title: 'Products', emoji: '📦',
      properties: { Name: { title: {} }, Description: { rich_text: {} }, Price: { number: { format: 'number' } }, 'Product ID': { rich_text: {} }, 'Shared By': { rich_text: {} }, Added: { created_time: {} } },
    },
    orders: {
      title: 'Orders', emoji: '🧾',
      properties: {
        Order: { title: {} },
        Customer: { relation: { data_source_id: contactsDs, type: 'single_property', single_property: {} } },
        Products: { relation: { data_source_id: productsDs, type: 'single_property', single_property: {} } },
        Items: { rich_text: {} },
        Status: { select: opts(['New', 'Confirmed', 'Dispatched', 'Delivered', 'Cancelled'], ['orange', 'blue', 'purple', 'green', 'red']) },
        'Order Date': { date: {} },
        From: { rich_text: {} },
        'WhatsApp Order ID': { rich_text: {} },
      },
    },
  };
}

const client = (token) => new Client({ auth: token, timeoutMs: 30000 });

// Validates the token and lists pages the integration was shared with.
async function connect(token) {
  const n = client(token);
  const me = await n.users.me({});
  const res = await n.search({ filter: { property: 'object', value: 'page' }, page_size: 50 });
  const pages = res.results
    .filter((p) => p.parent?.type !== 'data_source_id' && p.parent?.type !== 'database_id') // real pages, not db rows
    .map((p) => {
      const t = Object.values(p.properties || {}).find((x) => x.type === 'title');
      return { id: p.id, title: t?.title?.map((r) => r.plain_text).join('') || 'Untitled', icon: p.icon?.emoji || null, top: p.parent?.type === 'workspace' };
    });
  return { workspace: me.bot?.workspace_name || 'Notion', pages };
}

async function children(n, blockId) {
  const out = [];
  let cursor;
  do {
    const r = await n.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

// Where Kairos lives: a shared page called "Kairos" is used as-is; otherwise a "Kairos" page is
// made inside the first top-level page the integration can see.
function pickParent(pages) {
  return pages.find((p) => p.title.trim().toLowerCase() === 'kairos') || pages.find((p) => p.top) || pages[0];
}

// Idempotent: finds or creates the Kairos page and its four databases, adds any missing columns,
// and recreates a database the user deleted. Safe to run on every boot.
async function ensure(token, parent) {
  const n = client(token);
  let home = parent;
  if (parent.title.trim().toLowerCase() !== 'kairos') {
    const existing = (await children(n, parent.id)).find((b) => b.type === 'child_page' && b.child_page.title === 'Kairos');
    home = existing
      ? { id: existing.id }
      : await n.pages.create({
          parent: { type: 'page_id', page_id: parent.id },
          icon: { type: 'emoji', emoji: '🐈‍⬛' },
          properties: { title: { title: txt('Kairos') } },
          children: [{ type: 'callout', callout: { icon: { type: 'emoji', emoji: '🐾' }, color: 'orange_background', rich_text: txt('Kairos files your WhatsApp meetings, documents and orders here. Rename or rearrange anything — just keep these four databases on this page.') } }],
        });
  }
  const homePage = await n.pages.retrieve({ page_id: home.id });

  const found = {};
  for (const b of await children(n, home.id)) if (b.type === 'child_database') found[b.child_database.title] ??= b.id;

  const dbs = {};
  const want = async (key, s) => {
    if (found[s.title]) {
      const db = await n.databases.retrieve({ database_id: found[s.title] });
      if (!db.in_trash && !db.archived) {
        const ds = db.data_sources[0].id;
        await n.dataSources.update({ data_source_id: ds, properties: s.properties }); // adds missing columns
        return (dbs[key] = { db: db.id, ds, url: db.url });
      }
    }
    const db = await n.databases.create({
      parent: { type: 'page_id', page_id: home.id },
      title: txt(s.title),
      icon: { type: 'emoji', emoji: s.emoji },
      initial_data_source: { properties: s.properties },
    });
    dbs[key] = { db: db.id, ds: db.data_sources[0].id, url: db.url };
  };
  const base = schemas();
  await want('contacts', base.contacts);
  await want('employees', base.employees);
  await want('products', base.products);
  await want('orders', schemas(dbs.contacts.ds, dbs.products.ds).orders); // relations need the ids above
  return { homeId: home.id, homeUrl: homePage.url, dbs };
}

function createLogger(getCfg, saveCfg) {
  const n = () => client(getCfg().notion.token);
  const dbs = () => getCfg().notion.dbs;
  const today = () => new Date().toISOString();

  async function person(chatId, info) {
    const cfg = getCfg();
    const db = info.role === 'employee' ? 'employees' : 'contacts';
    const known = cfg.people[chatId];
    if (known && known.db === db) return known;
    if (known) {
      // Role changed: move the page (timeline included) between Contacts and Employees.
      const moved = await n().pages.move({ page_id: known.pageId, parent: { type: 'data_source_id', data_source_id: dbs()[db].ds } });
      await n().pages.update({ page_id: known.pageId, icon: { type: 'emoji', emoji: db === 'employees' ? '🧑‍💼' : '👤' } });
      Object.assign(known, { db, url: moved.url || known.url });
      saveCfg();
      return known;
    }
    const page = await n().pages.create({
      parent: { type: 'data_source_id', data_source_id: dbs()[db].ds },
      icon: { type: 'emoji', emoji: db === 'employees' ? '🧑‍💼' : '👤' },
      properties: {
        Name: { title: txt(info.name || info.number || chatId) },
        ...(info.number ? { Phone: { phone_number: '+' + String(info.number).replace(/\D/g, '') } } : {}),
        'WhatsApp ID': { rich_text: txt(chatId) },
        'Last Activity': { date: { start: today() } },
        Documents: { number: 0 },
      },
    });
    cfg.people[chatId] = { pageId: page.id, db, url: page.url, docs: 0 };
    saveCfg();
    return cfg.people[chatId];
  }

  const stamp = () => new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const callout = (emoji, text, color) => ({ type: 'callout', callout: { rich_text: txt(text), icon: { type: 'emoji', emoji }, color } });
  // Returns the new blocks as undo entries, so a wrongly-filed item can be taken back out.
  const append = async (pageId, children) => (await n().blocks.children.append({ block_id: pageId, children })).results.map((b) => ({ block: b.id }));
  const touch = (pageId, extra = {}) => n().pages.update({ page_id: pageId, properties: { 'Last Activity': { date: { start: today() } }, ...extra } });

  return {
    person,

    async meeting(chatId, info, ev) {
      const p = await person(chatId, info);
      const when = ev.when ? ` — ${ev.when.replace('T', ' ').slice(0, 16)}` : '';
      const undo = await append(p.pageId, [{ type: 'to_do', to_do: { rich_text: txt(`📅 Meeting request${when}: "${ev.title}" · ${stamp()}`), checked: false } }]);
      await touch(p.pageId, { 'Meeting Request': { rich_text: txt(ev.title) }, ...(ev.when ? { 'Meeting Date': { date: { start: ev.when } } } : {}) });
      return { url: p.url, undo };
    },

    async important(chatId, info, ev) {
      const p = await person(chatId, info);
      const undo = await append(p.pageId, [callout('💬', `${ev.title} · ${stamp()}`, 'gray_background')]);
      await touch(p.pageId);
      return { url: p.url, undo };
    },

    async document(chatId, info, ev, file) {
      const p = await person(chatId, info);
      const block = [];
      try {
        if (file.buffer.length > 20 * 1024 * 1024) throw new Error('over the 20 MB single-upload limit');
        const up = await n().fileUploads.create({ mode: 'single_part', filename: file.name, content_type: file.mimetype });
        await n().fileUploads.send({ file_upload_id: up.id, file: { filename: file.name, data: new Blob([file.buffer], { type: file.mimetype }) } });
        const kind = file.mimetype.startsWith('image/') ? 'image' : file.mimetype === 'application/pdf' ? 'pdf' : 'file';
        block.push({ type: kind, [kind]: { type: 'file_upload', file_upload: { id: up.id }, caption: txt(`${file.name} · ${stamp()}`) } });
      } catch (e) {
        // Free Notion workspaces cap uploads at 5 MB — the file is still safe on disk.
        block.push(callout('📎', `${file.name} saved on this PC: ${file.localPath} (not uploaded: ${e.message})`, 'orange_background'));
      }
      const undo = await append(p.pageId, block);
      p.docs = (p.docs || 0) + 1;
      saveCfg();
      await touch(p.pageId, { Documents: { number: p.docs } });
      return { url: p.url, undo };
    },

    async order(chatId, info, ev) {
      const p = await person(chatId, info);
      const page = await n().pages.create({
        parent: { type: 'data_source_id', data_source_id: dbs().orders.ds },
        properties: {
          Order: { title: txt(ev.title) },
          ...(p.db === 'contacts' ? { Customer: { relation: [{ id: p.pageId }] } } : {}),
          Items: { rich_text: txt(ev.text) },
          Status: { select: { name: 'New' } },
          'Order Date': { date: { start: today() } },
          From: { rich_text: txt(info.name || chatId) },
          ...(ev.orderId ? { 'WhatsApp Order ID': { rich_text: txt(ev.orderId) } } : {}),
        },
      });
      const undo = await append(p.pageId, [callout('🧾', `Order logged: ${ev.title} · ${stamp()}`, 'orange_background')]);
      await touch(p.pageId);
      return { url: page.url, undo: [{ page: page.id }, ...undo] };
    },

    async product(chatId, info, ev) {
      const pr = ev.product || {};
      const page = await n().pages.create({
        parent: { type: 'data_source_id', data_source_id: dbs().products.ds },
        properties: {
          Name: { title: txt(ev.title) },
          Description: { rich_text: txt(pr.description || ev.text || '') },
          ...(pr.productId ? { 'Product ID': { rich_text: txt(pr.productId) } } : {}),
          'Shared By': { rich_text: txt(info.name || chatId) },
        },
      });
      return { url: page.url, undo: [{ page: page.id }] };
    },

    // Takes back what a filing created (blocks on the person's page, order/product rows).
    async undo(entries = []) {
      for (const u of entries) {
        try {
          if (u.block) await n().blocks.delete({ block_id: u.block });
          if (u.page) await n().pages.update({ page_id: u.page, in_trash: true });
        } catch (e) { if (e.code !== 'object_not_found') throw e; } // already gone: fine
      }
    },
  };
}

module.exports = { connect, ensure, pickParent, createLogger };
