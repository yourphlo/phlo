// Tests for the shared PHLO logic (web/core.js + web/stores.js).
//   node test/run.js            unit checks, plus sheet-snapshot checks if test/fixtures/ exists
//   node test/run.js --print    also print the rows built from the snapshots
// The snapshots hold patient data, so they stay local (see .gitignore); CI runs the unit checks only.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const ctx = {};
vm.createContext(ctx);
for (const f of ['web/stores.js', 'web/core.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });

let failures = 0;
const eq = (a, b, msg) => {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  failures++;
  console.log('FAIL', msg, '\n  got ', JSON.stringify(a), '\n  want', JSON.stringify(b));
};
const delivery = ctx.phloUtc(2026, 10, 20);

/* ---------- unit checks (no patient data) ---------- */
eq(ctx.phloSplitNameAddress('DOE, JANE - 100 MAPLE AVE  TOWN CA 91000'), ['DOE, JANE', '100 MAPLE AVE TOWN CA 91000'], 'dash separator');
eq(ctx.phloSplitNameAddress('DOE,JOHN -, 200 OAK BLVD APT 2 TOWN CA 91000')[0], 'DOE,JOHN -', 'keeps name flag');
eq(ctx.phloSplitNameAddress('ROE, ANA M.300 ELM AVE. TOWN CA 91000'), ['ROE, ANA M.', '300 ELM AVE. TOWN CA 91000'], 'no space before number');
eq(ctx.phloSplitNameAddress('ROE,ANN|40 W PINE BLVD TOWN CA 910001234|555-555-0100|'), ['ROE,ANN', '40 W PINE BLVD TOWN CA 91000'], 'pipe + zip+4');
eq(ctx.phloSplitNameAddress('ROE,BO\n500 e cedar dr  apt 5  \ntown ca 91000,(555) 555-0101'), ['ROE,BO', '500 e cedar dr apt 5 town ca 91000'], 'newline + phone');
eq(ctx.phloPickTabs(['OCT 2026🎃', 'SEPT. 2026', '10.19.26', 'Copy of 10.2.26 ROUTE'], delivery, {}), ['OCT 2026🎃'], 'tab pick');
eq(ctx.phloPickTabs(['RX OCT 2026', 'DME OCT 2026', 'RX SEPT 2026'], ctx.phloUtc(2026, 11, 2), { prefix: 'RX' }), ['RX OCT 2026'], 'month boundary');
eq(ctx.phloPickTabs(['OCT-2026', 'SEP-2026', 'TEMPLATE'], delivery, {}), ['OCT-2026'], 'dash tab name');
eq(ctx.phloPickupDates(ctx.phloUtc(2026, 10, 19)).map(d => d.toISOString().slice(0, 10)), ['2026-10-18', '2026-10-17'], 'monday window');
eq(ctx.phloExplicitDate('DEL 10.20.2026 \nAFTER 1 PM', delivery).toISOString().slice(0, 10), '2026-10-20', 'explicit DEL date');
eq(ctx.phloExplicitDate('must be delivered 10/20, open gate', delivery).toISOString().slice(0, 10), '2026-10-20', 'must be delivered');
eq(ctx.phloCleanNote('must be delivered 10/20, open gate, goto front door'), 'open gate, goto front door', 'clean note');

const fakeStore = { code: 'TST', cols: { date: 0, id: 1, name: 2, copay: 3, notes: [4] } };
const fake = [
  ['10/16/2026', '1000001', 'OLD,ROW, 1 A ST TOWN CA 91000', '', ''],
  ['10/19/2026', '1000002', 'ONE,PAT, 5 B ST TOWN CA 91000', '1.6', 'collect cash'],
  ['', '1000003', 'TWO,PAT, 9 C AVE APT 4 TOWN CA 91000', '', 'COMBO ⬇️'],
  ['', '1000004', 'THREE,PAT, 9 C AVE #4 TOWN CA 91000', '', 'COMBO ⬆️ FRIDGE'],
  ['', '1000005', 'LATE,PAT, 7 D ST TOWN CA 91000', '', 'DEL 10.21.2026'],
];
eq(ctx.phloStoreRows(fake, fakeStore, delivery), [
  ['1000002,ONE,PAT', '5 B ST TOWN CA 91000', 'TST', '$1.60-collect cash'],
  ['1000003, 1000004,TWO,PAT, & THREE,PAT', '9 C AVE APT 4 TOWN CA 91000', 'TST', 'COMBO-FRIDGE'],
], 'date pick + combo + explicit later date skipped');

const checks = ctx.phloCheckRows([
  ['1000010, 1000011,V 1000012, A,B, & C,D', '600 BIRCH AVE APT 5 TOWN CA 91000', 'EM', ''],
  ['1000013,X,Y', '700 ASH AVE APT 1 TOWN CA 910002', 'WT DME', ''],
  ['1000014,F,R', '800 N FIR AVE. 900 OLIVE ST. TOWN CA 91000', 'BP', ''],
  ['1000015,L,K', '1000 PALM AVE TOWN CA 91000', 'EM', ''],
  ['1000015,L,K', '1000 PALM AVE TOWN CA 91000', 'EM', ''],
  ['1000016,N,H', '1100 HILL BLVD D 204 LA VERNE CA 91000', 'RM', ''],
]).map(c => c.row + ':' + c.message.split(':')[0].split(' (')[0].replace(/\d{7}/, '#'));
eq(checks, ['0:Stray letters between RX numbers', '1:ZIP "910002" has 6 digits', '2:Looks like two addresses', '4:RX # is also on row 5', '4:Same address as row 5 - combine?'], 'checks');

const cmp = ctx.phloCompare(
  [['1000017,LI,Z', '1 W LN TOWN CA 91000', 'EM', ''], ['1000018,C,C', '2 E AVE TOWN CA 91000', 'EM', '']],
  [['1000018,C,C', '2 E AVE TOWN CA 91000', 'EM', ''], ['999999,X', '1 A ST TOWN CA 91000', 'EM', '']]);
eq(cmp.stores.map(s => [s.code, s.missing.map(r => r[0]), s.extra.map(r => r[0])]), [['EM', ['1000017,LI,Z'], ['999999,X']]], 'compare');

try { execFileSync('node', [path.join(root, 'scripts/sync-apps-script.js'), '--check'], { stdio: 'inherit' }); }
catch (e) { failures++; }

/* ---------- sheet snapshots (local only) ---------- */
const fixtures = path.join(__dirname, 'fixtures');
const expectedFile = path.join(__dirname, 'expected-10.20.26.json');
if (fs.existsSync(fixtures) && fs.existsSync(expectedFile)) {
  const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
  const all = [];
  for (const store of ctx.STORES) {
    const file = path.join(fixtures, store.code.replace(' ', '_') + '.json');
    if (!fs.existsSync(file)) continue;
    const rows = ctx.phloStoreRows(JSON.parse(fs.readFileSync(file, 'utf8')), store, delivery);
    all.push(...rows);
    if (process.argv.includes('--print')) rows.forEach(r => console.log(r.join('  ||  ')));
    if (!expected[store.code]) continue;
    eq(rows.map(r => ctx.phloRxNumbers(r[0]).join(' ')), expected[store.code], 'snapshot ' + store.code);
  }
  console.log(`snapshots: ${all.length} rows`);
  if (process.argv.includes('--json')) fs.writeFileSync(process.argv[process.argv.indexOf('--json') + 1], JSON.stringify(all));
} else {
  console.log('snapshots: skipped (test/fixtures not present)');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
