const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('a corrupt config is restored from the backup, never wiped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-cfg-'));
  process.env.KAIROS_DATA = dir;
  process.env.KAIROS_DOCS = path.join(dir, 'docs');
  const config = require('./config');

  const cfg = config.load();
  cfg.monitored = { 'a@c.us': { name: 'A' } };
  config.save();
  config.save(); // second save makes the .bak hold the monitored chat too
  fs.writeFileSync(config.paths.config, '{ half a fil');

  const again = config.load();
  assert.deepEqual(again.monitored, { 'a@c.us': { name: 'A' } });
  assert.equal(again.token, cfg.token);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('config.json.corrupt-')), 'corrupt copy kept for inspection');
  fs.rmSync(dir, { recursive: true, force: true });
});
