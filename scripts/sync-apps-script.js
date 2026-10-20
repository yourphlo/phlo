// Copies the shared files from web/ into apps-script/ (Apps Script shares globals across .gs files).
//   node scripts/sync-apps-script.js          -> copy
//   node scripts/sync-apps-script.js --check  -> fail if out of date (used by tests/CI)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const pairs = [['web/core.js', 'apps-script/Core.gs'], ['web/stores.js', 'apps-script/Stores.gs']];
let stale = 0;
for (const [from, to] of pairs) {
  const src = fs.readFileSync(path.join(root, from), 'utf8');
  const dst = path.join(root, to);
  const cur = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;
  if (cur === src) continue;
  if (process.argv.includes('--check')) { console.log(`${to} is out of date - run node scripts/sync-apps-script.js`); stale++; }
  else { fs.writeFileSync(dst, src); console.log(`updated ${to}`); }
}
process.exit(stale ? 1 : 0);
