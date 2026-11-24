// electron-builder never copies node_modules through extraResources, so OpenWA's runtime
// dependencies are copied into the packaged app here.
const fs = require('fs');
const path = require('path');

exports.default = async ({ appOutDir }) => {
  const from = path.join(__dirname, '..', 'vendor', 'openwa', 'node_modules');
  const to = path.join(appOutDir, 'resources', 'vendor', 'openwa', 'node_modules');
  fs.cpSync(from, to, { recursive: true, dereference: true });
};
