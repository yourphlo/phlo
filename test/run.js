// Tests for the shared PHLO logic (web/core.js + web/stores.js + web/drivers.js).
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
for (const f of ['web/stores.js', 'web/core.js', 'web/drivers.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });

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

// TX-style store: one fixed tab, date rows in the name column, bags column, ***notes*** in names.
const txStore = { code: 'TX', tab: { name: 'PHLO' }, nameNotes: true, cols: { date: 2, id: 3, name: 2, address: 4, bags: 5, fridge: 6, notes: [7] } };
eq(ctx.phloPickTabs(['10/20', 'PHLO', 'TEMPLATE', 'OCT 2026'], ctx.phloUtc(2026, 10, 21), txStore.tab), ['PHLO'], 'fixed tab name');
eq(ctx.phloStoreRows([
  ['', '', 'Collected', 'Log Number', 'PT Name & Address', '#OF BAGS'], ['', '', '10/19'],
  ['', '', 'OLD HOME', '1000020', '1 A ST TOWN CA 91000', '1'],
  ['', '', 'Collected', 'Log Number', 'PT Name & Address', '#OF BAGS'], ['', '', '10/20'],
  ['', '', 'SUN HOME 2', '1000021, 1000022', '2 B AVE, TOWN, CA 91000', '4'],
  ['', '', 'HILL CARE ***DELIVER 8AM TO 5PM***', '1000023', '3 C ST TOWN CA 91000', '(3 BAGS/ 1 BOX)', 'YES'],
  ['', '', 'ONE BAG HOME', '1000024', '4 D ST TOWN CA 91000', '1'],
  ['', '', 'Collected', 'Log Number', 'PT Name & Address', '#OF BAGS'],
], txStore, ctx.phloUtc(2026, 10, 21)), [
  ['1000021, 1000022,SUN HOME 2', '2 B AVE TOWN CA 91000', 'TX', '4 BAGS'],
  ['1000023,HILL CARE', '3 C ST TOWN CA 91000', 'TX', 'FRIDGE-3 BAGS/ 1 BOX-DELIVER 8AM TO 5PM'],
  ['1000024,ONE BAG HOME', '4 D ST TOWN CA 91000', 'TX', ''],
], 'TX store');

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

/* ---------- driver profiles ---------- */
eq(['9:5', '0905', '9:05 am', '1:30 PM', '12 am', '24:00', 'noon', ''].map(ctx.phloParseTime), [null, '09:05', '09:05', '13:30', '00:00', null, null, ''], 'parse time');
eq(ctx.phloParseTypes('FRIDGE, fridge ,FRIDGE,, DME'), ['FRIDGE', 'fridge', 'DME'], 'types are case sensitive + deduped');
const drv = ctx.phloNormalizeDriver({ id: 'a', name: '  Ana  Ruiz ', startAddress: '1 Main St', capacity: '40', speed: 'fast', availableFrom: '8:00 am', availableTo: '5 pm', lunchFrom: '12:00', lunchTo: '12:30', types: 'FRIDGE' });
eq([drv.name, drv.capacity, drv.speed, drv.availableFrom, drv.availableTo, drv.types], ['Ana Ruiz', 40, 'FAST', '08:00', '17:00', ['FRIDGE']], 'normalize driver');
eq(ctx.phloValidateDriver(drv, []), [], 'valid driver');
eq(ctx.phloNormalizeDriver({ name: 'x', speed: 'turbo' }).speed, 'NORMAL', 'unknown speed -> NORMAL');
const bad = ctx.phloNormalizeDriver({ id: 'b', name: 'ana ruiz', capacity: '0', mobile: '555-01', availableFrom: '17:00', availableTo: '08:00', lunchFrom: '12:00' });
eq(ctx.phloValidateDriver(bad, [drv]).map(e => e.field), ['name', 'startAddress', 'availableTo', 'lunchTo', 'capacity', 'mobile'], 'driver errors');
const lunchOut = ctx.phloNormalizeDriver({ name: 'B', startAddress: 'x', availableFrom: '09:00', availableTo: '13:00', lunchFrom: '13:00', lunchTo: '13:30' });
eq(ctx.phloValidateDriver(lunchOut, []).map(e => e.field), ['lunchFrom'], 'lunch outside hours');
eq(ctx.phloDriverRows([drv])[1], ['Ana Ruiz', '1 Main St', '', '08:00', '17:00', '', 40, 'FRIDGE', 'FAST (190%)', '12:00', '12:30'], 'driver export row');
const roster = ctx.phloDriversData({ drivers: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], roster: { '2026-10-19': ['a'], '2026-10-21': ['b', 'gone'], bad: ['a'] } });
eq([ctx.phloRosterFor(roster, '2026-10-18'), ctx.phloRosterFor(roster, '2026-10-20'), ctx.phloRosterFor(roster, '2026-10-21')], [['a', 'b'], ['a'], ['b']], 'roster fallback');
eq(Object.keys(roster.roster), ['2026-10-19', '2026-10-21'], 'roster drops bad keys');

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
    // A snapshot is either the rows, or {delivery: 'yyyy-mm-dd', values: rows} for a different date.
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    const when = !Array.isArray(snap) && snap.delivery ? ctx.phloUtc(...snap.delivery.split('-').map(Number)) : delivery;
    const rows = ctx.phloStoreRows(Array.isArray(snap) ? snap : snap.values, store, when);
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
