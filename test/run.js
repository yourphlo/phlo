// Runs the Apps Script parsing logic in Node against saved sheet snapshots.
//   node test/run.js            -> checks against test/expected-10.20.26.json
//   node test/run.js --print    -> prints the rows it builds
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8'), ctx);

const delivery = ctx.phloUtc(2026, 10, 20);
const fixtures = path.join(__dirname, 'fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected-10.20.26.json'), 'utf8'));
const print = process.argv.includes('--print');

let failures = 0;
const all = [];
for (const store of ctx.STORES) {
  const file = path.join(fixtures, store.code.replace(' ', '_') + '.json');
  if (!fs.existsSync(file)) continue;
  const rows = ctx.phloStoreRows(JSON.parse(fs.readFileSync(file, 'utf8')), store, delivery);
  all.push(...rows);
  if (print) rows.forEach(r => console.log(r.join('  ||  ')));
  const want = expected[store.code];
  if (!want) continue;
  const got = rows.map(r => r[0].split(',').filter(x => /^\s*\d{5,}\s*$/.test(x)).map(x => x.trim()).join(' '));
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.log(`FAIL ${store.code}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
  } else {
    console.log(`ok   ${store.code} (${rows.length} rows)`);
  }
}

// small unit checks
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) { failures++; console.log('FAIL', msg, JSON.stringify(a), '!=', JSON.stringify(b)); } };
eq(ctx.phloSplitNameAddress('LATINI, JACQUELINE - 1660 SANTA FE AVE  GLENDORA CA 91740'), ['LATINI, JACQUELINE', '1660 SANTA FE AVE GLENDORA CA 91740'], 'dash separator');
eq(ctx.phloSplitNameAddress('TE,GUECH MAN -, 10310 VALLEY BLVD APT 212 EL MONTE CA 91731')[0], 'TE,GUECH MAN -', 'keeps name flag');
eq(ctx.phloSplitNameAddress('RAMIREZ, ANA M.12029 SMALLWOOD AVE. DOWNEY CA 90242'), ['RAMIREZ, ANA M.', '12029 SMALLWOOD AVE. DOWNEY CA 90242'], 'no space before number');
eq(ctx.phloPickTabs(['OCT 2026🎃', 'SEPT. 2026', '10.19.26', 'Copy of 10.2.26 ROUTE'], delivery, {}), ['OCT 2026🎃'], 'tab pick');
eq(ctx.phloPickTabs(['RX OCT 2026', 'DME OCT 2026', 'RX SEPT 2026'], ctx.phloUtc(2026, 11, 2), { prefix: 'RX' }), ['RX OCT 2026'], 'month boundary');
eq(ctx.phloPickupDates(ctx.phloUtc(2026, 10, 19)).map(d => d.toISOString().slice(0, 10)), ['2026-10-18', '2026-10-17'], 'monday window');

console.log(failures ? `\n${failures} failure(s)` : `\nall good (${all.length} rows)`);
if (process.argv.includes('--json')) fs.writeFileSync(process.argv[process.argv.indexOf('--json') + 1], JSON.stringify(all));
process.exit(failures ? 1 : 0);
