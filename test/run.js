// Tests for the shared PHLO logic (web/core.js + web/stores.js + web/drivers.js + web/dispatch.js + web/texts.js)
// and the dispatch server (apps-script-dispatch/, run on test/fake-apps-script.js).
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
for (const f of ['web/stores.js', 'web/core.js', 'web/drivers.js', 'web/dispatch.js', 'web/texts.js']) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });

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

// Cells pasted from Excel: tabs between cells, quoted cells with line breaks and "" quotes.
eq(ctx.phloParsePasted('A\tB\r\n"line 1\nline 2"\t"say ""hi"""\r\n\t\r\n'), [['A', 'B'], ['line 1\nline 2', 'say "hi"']], 'paste parse');
const bpStore = ctx.STORES.find(s => s.code === 'BP');
const bpPaste = [
  'BP PHLO PICK UP ON 10/15/2026',
  'TIME\tSTORE\tRX #\tPATIENT\t\t\t\tNOTES\tCOPAY',
  '9AM\tBP\t1000031\t"PAT,ONE\n10 A ST TOWN CA 91000"\t\t\t\tgate code 12\t$4.50',
  'Sat 10/17/26',
  '\t\t1000032\tPAT,TWO, 20 B ST TOWN CA 91000\t\t\t\t\t',
].join('\n');
const monday = ctx.phloUtc(2026, 10, 19);
const bpWant = [
  ['1000031,PAT,ONE', '10 A ST TOWN CA 91000', 'BP', '$4.50-gate code 12'],
  ['1000032,PAT,TWO', '20 B ST TOWN CA 91000', 'BP', ''],
];
let p = ctx.phloPasted(bpPaste, bpStore, monday);
eq([p.rx, p.rxCol], [2, 2], 'BP paste: RX column C');
eq(ctx.phloStoreRows(p.values, p.store, monday), bpWant, 'BP pasted cells (stray dates ignored)');
// Copied from column B instead of A: everything shifts one column left.
p = ctx.phloPasted([
  'BP\t1000031\t"PAT,ONE\n10 A ST TOWN CA 91000"\t\t\t\tgate code 12\t$4.50',
  '\t1000032\tPAT,TWO, 20 B ST TOWN CA 91000\t\t\t\t\t',
].join('\n'), bpStore, monday);
eq(p.rxCol, 1, 'BP paste from column B');
eq(ctx.phloStoreRows(p.values, p.store, monday), bpWant, 'BP pasted from column B');
eq(ctx.phloPasted('just\ttext\nno numbers', bpStore, monday).rx, 0, 'paste without RX numbers');

// Santa Ana: paste only, columns line up on the RX numbers; address in the name cell or the next column.
const saStore = ctx.STORES.find(s => s.code === 'SA');
eq([!!saStore.paste, saStore.id, saStore.search], [true, undefined, undefined], 'SA is paste only');
p = ctx.phloPasted([
  'DATE\tRX #\tPATIENT\tADDRESS\tCOPAY\tNOTES',
  '10/18/2026\t1000041\tPAT,SA ONE\t30 MAIN ST SANTA ANA CA 92701\t$2.50\tleave at door',
  '10/18/2026\t1000042\tPAT,SA TWO, 40 BRISTOL ST SANTA ANA CA 92703\t\tFRIDGE',
].join('\n'), saStore, monday);
eq([p.rx, p.rxCol], [2, 1], 'SA paste: RX column B');
eq(ctx.phloStoreRows(p.values, p.store, monday), [
  ['1000041,PAT,SA ONE', '30 MAIN ST SANTA ANA CA 92701', 'SA', '$2.50-leave at door'],
  ['1000042,PAT,SA TWO', '40 BRISTOL ST SANTA ANA CA 92703', 'SA', 'FRIDGE'],
], 'SA pasted cells');

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
const oneSided = ['availableFrom', 'availableTo'].map(k => ctx.phloValidateDriver(ctx.phloNormalizeDriver({ name: 'C', startAddress: 'x', [k]: '09:00' }), []));
eq(oneSided, [[], []], 'availability can be just a start or just an end');
eq(ctx.phloValidateDriver(ctx.phloNormalizeDriver({ name: 'C', startAddress: 'x', availableFrom: '13:00', lunchFrom: '12:00', lunchTo: '12:30' }), []).map(e => e.field), ['lunchFrom'], 'lunch before a start-only shift');
eq(ctx.phloValidateDriver(ctx.phloNormalizeDriver({ name: 'C', startAddress: 'x', lunchFrom: '12:00' }), []).map(e => e.field), ['lunchTo'], 'lunch still needs both times');
const pin = { address: '1 Main St, Los Angeles, CA 90012, USA', lat: 34.05, lng: -118.24, placeId: 'abc' };
const pinned = ctx.phloNormalizeDriver({ name: 'P', startAddress: pin.address, startPin: pin, endAddress: '2 Elm St', endPin: pin });
eq([pinned.startPin, pinned.endPin], [pin, null], 'pin kept only while it matches the address');
eq(ctx.phloNormalizePin({ address: 'x', lat: 'bad', lng: 0 }, 'x'), null, 'pin needs coordinates');
eq([ctx.phloMapsUrl('1 Main St', null), ctx.phloMapsUrl(pin.address, pin)],
  ['https://www.google.com/maps/search/?api=1&query=1%20Main%20St', 'https://www.google.com/maps/search/?api=1&query=34.05,-118.24&query_place_id=abc'], 'maps links');
eq(ctx.phloDriverRows([drv])[1], ['Ana Ruiz', '1 Main St', '', '08:00', '17:00', '', 40, 'FRIDGE', 'FAST (190%)', '12:00', '12:30'], 'driver export row');
const roster = ctx.phloDriversData({ drivers: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], roster: { '2026-10-19': ['a'], '2026-10-21': ['b', 'gone'], bad: ['a'] } });
eq([ctx.phloRosterFor(roster, '2026-10-18'), ctx.phloRosterFor(roster, '2026-10-20'), ctx.phloRosterFor(roster, '2026-10-21')], [['a', 'b'], ['a'], ['b']], 'roster fallback');
eq(Object.keys(roster.roster), ['2026-10-19', '2026-10-21'], 'roster drops bad keys');

/* ---------- coverage areas ---------- */
eq(ctx.phloNormalizeAreas([[[34.123456, -118.1], ['34.2', '-118.2'], [34.2, -118.2], [34.3, -118.0], [34.123456, -118.1]], [[1, 2], [3, 4]], 'x', [[91, 0], [0, 0], [1, 1], [2, 2]]]),
  [[[34.12346, -118.1], [34.2, -118.2], [34.3, -118]], [[0, 0], [1, 1], [2, 2]]], 'areas: rounded, deduped, open, bad points and short outlines dropped');
eq(ctx.phloNormalizeAreas(null), [], 'no areas');
eq(ctx.phloSimplifyPath([[0, 0], [1, 0.2], [2, -0.1], [3, 0], [3, 5], [3.1, 10]], 1), [[0, 0], [3, 0], [3.1, 10]], 'simplify drops points on a straight run');
eq(ctx.phloSimplifyPath([[0, 0], [5, 5]], 1), [[0, 0], [5, 5]], 'simplify keeps short lines');
const area = [[34, -118], [34.1, -118], [34.1, -118.1]];
const withAreas = ctx.phloNormalizeDriver({ id: 'z', name: 'Z', startAddress: 'x', areas: [area], color: '#ABCDEF' });
eq([withAreas.areas, withAreas.color], [[area], '#abcdef'], 'driver keeps areas + colour');
eq(ctx.phloNormalizeDriver({ name: 'Z', color: 'red' }).color, '', 'bad colour dropped');
eq(ctx.phloDriverColors([{ id: 'a', color: '' }, { id: 'b', color: '#d1495b' }, { id: 'c', color: '' }]), { b: '#d1495b', a: '#2b7bba', c: '#2a9d5c' }, 'colours: saved kept, others get unused ones');
const gj = ctx.phloAreasGeoJson([withAreas, ctx.phloNormalizeDriver({ id: 'y', name: 'Y' })]);
eq(gj.features.length, 1, 'geojson skips drivers with no areas');
eq([gj.features[0].properties.driver, gj.features[0].geometry.coordinates], ['Z', [[[[-118, 34], [-118, 34.1], [-118.1, 34.1], [-118, 34]]]]], 'geojson is lng,lat and closed');
eq(ctx.phloDriverRows([withAreas])[0].length, 11, 'areas not in the drivers export');
const app1 = ctx.phloNormalizeDriver({ id: 'u1', name: 'Ana Ruiz', startAddress: 'x', pinSalt: 'abcdef0123456789', pinHash: 'a'.repeat(64) });
const app2 = ctx.phloNormalizeDriver({ id: 'u2', name: 'Ana Lee', startAddress: 'x' });
eq([app1.username, ctx.phloLoginName(app1), app1.pinHash.length, ctx.phloNormalizeDriver({ name: 'x', pinHash: 'nothex' }).pinHash], ['', 'ana', 64, ''], 'app login fields');
eq(ctx.phloValidateDriver(app2, [app1], '12').map(e => e.field), ['username', 'pin'], 'app username clash + bad pin');
eq(ctx.phloValidateDriver(ctx.phloNormalizeDriver({ id: 'u2', name: 'Ana Lee', startAddress: 'x', username: 'Ana L' }), [app1], '123456'), [], 'own app username ok');

/* ---------- dispatch ---------- */
eq([ctx.phloGeocodeQuality(['street_address']), ctx.phloGeocodeQuality(['premise'], true), ctx.phloGeocodeQuality(['route']), ctx.phloGeocodeQuality(['country', 'political']), ctx.phloGeocodeQuality(['postal_code'])], ['ok', 'partial', 'partial', 'none', 'none'], 'geocode quality');
eq([ctx.phloClock('09:05'), ctx.phloClock('13:30'), ctx.phloClock('00:10'), ctx.phloClock('12:00')], ['9:05 AM', '1:30 PM', '12:10 AM', '12:00 PM'], 'clock');
eq(Math.round(ctx.phloKm({ lat: 34, lng: -118 }, { lat: 35, lng: -118 })), 111, 'km per degree of latitude');
const sq = [[34, -118], [34, -117.9], [34.1, -117.9], [34.1, -118]];
eq([ctx.phloInArea({ lat: 34.05, lng: -117.95 }, sq), ctx.phloInArea({ lat: 34.2, lng: -117.95 }, sq)], [true, false], 'point in area');
eq([ctx.phloStopId(['1234567,DOE,JANE', 'x']), ctx.phloStopId(['1234567 & 7654321,DOE', 'x']), ctx.phloStopId(['DOE', '1 A St']) === ctx.phloStopId(['DOE', '1 A St'])], ['rx1234567', 'rx1234567_7654321', true], 'stop ids');
eq(ctx.phloStopInfo(['n', 'a', 'EM', '$1.60-$2.00-COMBO-FRIDGE-PAID']), { store: 'EM', copay: '$3.60', tags: ['COMBO', 'FRIDGE', 'PAID'] }, 'stop info');
// Assignment: A covers the west square, B the east square, they overlap in the middle; C has FRIDGE.
const west = [[34, -118.2], [34, -118], [34.1, -118], [34.1, -118.2]], east = [[34, -118.05], [34, -117.8], [34.1, -117.8], [34.1, -118.05]];
const ds = [{ id: 'A', areas: [west], types: [], start: { lat: 34.05, lng: -118.15 } }, { id: 'B', areas: [east], types: [], start: { lat: 34.05, lng: -117.85 }, capacity: 1 },
  { id: 'C', areas: [], types: ['FRIDGE'], start: { lat: 34.3, lng: -118 } }];
const asg = ctx.phloAssignStops([
  { id: 'w', lat: 34.05, lng: -118.15, tags: [] }, { id: 'e', lat: 34.05, lng: -117.85, tags: [] },
  { id: 'mid', lat: 34.05, lng: -118.02, tags: [] }, { id: 'far', lat: 34.5, lng: -118.15, tags: [] },
  { id: 'cold', lat: 34.05, lng: -118.15, tags: ['FRIDGE'] }, { id: 'lost', lat: null, lng: null, tags: [] },
  { id: 'hand', lat: 34.05, lng: -118.15, tags: [], driverId: 'B' }], ds);
eq(Object.keys(asg).sort().map(k => k + ':' + asg[k].driverId + ':' + asg[k].flags.join('+')),
  ['cold:C:outside', 'e:null:full', 'far:C:outside', 'hand:B:manual', 'lost:null:notFound', 'mid:A:overlap', 'w:A:'], 'assign stops (B is full with the hand-picked stop, so e is left off and the overlap goes to A; far goes to the nearest start)');
// Notes that ask for a driver.
{
  const ds = [{ id: 'j', name: 'Jorge Ramos', username: '' }, { id: 'a', name: 'Ana Ruiz', username: 'ana' }, { id: 'w', name: 'Will Smith', username: '' }, { id: 'k', name: 'Kim Lee', username: 'kimmy' }];
  const t = n => JSON.stringify(ctx.phloNoteDrivers(n, ds));
  eq([t('$5.00-ONLY JORGE CAN DELIVERS'), t('Jorge only'), t('driver: Jorge'), t('give to jorge pls'), t('must be delivered by Jorge or Ana'),
      t('call Jorge (son) at door'), t('pt will deliver later'), t('only Will Smith'), t('kimmy only'), t('FRIDGE-COMBO'), t('')],
    ['["j"]', '["j"]', '["j"]', '["j"]', '["j","a"]', '[]', '[]', '["w"]', '["k"]', '[]', '[]'], 'driver named in a note');
  // Jorge's area is far away, Ana's covers the stop: the note still wins. If Jorge isn't working, the stop is left off.
  const area = [[34, -118.2], [34, -118], [34.1, -118], [34.1, -118.2]], farArea = [[34.5, -118.2], [34.5, -118], [34.6, -118], [34.6, -118.2]];
  const work = [{ id: 'a', areas: [area], types: [], capacity: 1, start: { lat: 34.05, lng: -118.1 } }, { id: 'j', areas: [farArea], types: [], capacity: 1, start: { lat: 34.55, lng: -118.1 } }];
  const st = [{ id: 'n', lat: 34.05, lng: -118.1, tags: [], only: ['j'] }, { id: 'n2', lat: 34.06, lng: -118.1, tags: [], only: ['j'] }, { id: 'x', lat: 34.05, lng: -118.11, tags: [] }];
  const r = ctx.phloAssignStops(st, work);
  eq([r.n.driverId, r.n2.driverId, r.n.flags, r.x.driverId], ['j', 'j', ['only'], 'a'], 'note picks the driver, past area and max stops');
  const r2 = ctx.phloAssignStops([{ id: 'n', lat: 34.05, lng: -118.1, tags: [], only: ['j'] }], [work[0]]);
  eq([r2.n.driverId, r2.n.flags], [null, ['onlyAbsent']], 'named driver not working: left off');
}
// A hard limit of 5 stops: 8 stops only A's area reaches -> 5 for A, 3 left off; with B's area nearby (within 2 miles), B takes the rest.
{
  const aArea = [[34, -118.2], [34, -118.1], [34.1, -118.1], [34.1, -118.2]], bArea = [[34, -118.095], [34, -118.0], [34.1, -118.0], [34.1, -118.095]];
  const st = []; for (let i = 0; i < 8; i++) st.push({ id: 's' + i, lat: 34.01 + i * 0.01, lng: -118.12, tags: [] });
  const count = (r, d) => Object.values(r).filter(x => x.driverId === d).length;
  const alone = ctx.phloAssignStops(st, [{ id: 'A', areas: [aArea], types: [], capacity: 5, start: { lat: 34.05, lng: -118.15 } }]);
  eq([count(alone, 'A'), Object.values(alone).filter(x => x.flags.includes('full')).length], [5, 3], 'max stops: the rest is left off the routes');
  const both = ctx.phloAssignStops(st, [{ id: 'A', areas: [aArea], types: [], capacity: 5, start: { lat: 34.05, lng: -118.15 } }, { id: 'B', areas: [bArea], types: [], capacity: 5, start: { lat: 34.05, lng: -118.05 } }]);
  eq([count(both, 'A'), count(both, 'B'), count(both, null)], [5, 3, 0], 'max stops: a neighbour within 2 miles takes the overflow');
}
// Yellow (Y) covers the west, purple (P) the east. Y's route runs north-south along lng -118.105.
// x sits just inside P's area but right on Y's route (like a stray #31): it goes to Y.
// z is inside P's area and more than 2 miles from Y's area: it stays with P even though Y passes nearer.
{
  const yArea = [[33.9, -118.4], [33.9, -118.1], [34.2, -118.1], [34.2, -118.4]], pArea = [[33.9, -118.098], [33.9, -117.8], [34.2, -117.8], [34.2, -118.098]];
  const Y = { id: 'Y', areas: [yArea], types: [], start: { lat: 33.95, lng: -118.105 } }, P = { id: 'P', areas: [pArea], types: [], start: { lat: 34.05, lng: -117.9 } };
  const st = [];
  for (let i = 0; i < 8; i++) st.push({ id: 'y' + i, lat: 33.96 + i * 0.02, lng: -118.105, tags: [] });
  for (let i = 0; i < 6; i++) st.push({ id: 'p' + i, lat: 34.0 + i * 0.02, lng: -117.9, tags: [] });
  st.push({ id: 'x', lat: 34.05, lng: -118.097, tags: [] });
  st.push({ id: 'z', lat: 34.05, lng: -118.05, tags: [] });
  const r = ctx.phloAssignStops(st, [Y, P]);
  eq([r.x.driverId, r.z.driverId, st.filter(s => /^y/.test(s.id)).every(s => r[s.id].driverId === 'Y'), st.filter(s => /^p/.test(s.id)).every(s => r[s.id].driverId === 'P')],
    ['Y', 'P', true, true], 'stray stop goes to the route that passes it; >2 miles from an area never');
  eq(ctx.phloAreaKm({ lat: 34.05, lng: -118.05 }, yArea) > 3.22, true, 'z is more than 2 miles from Y\'s area');
}
// Two drivers sharing one big area: their stops end up in two separate groups, not interleaved.
{
  const big = [[33.9, -118.4], [33.9, -117.8], [34.3, -117.8], [34.3, -118.4]];
  const A = { id: 'A', areas: [big], types: [], start: { lat: 34.1, lng: -118.35 } }, B = { id: 'B', areas: [big], types: [], start: { lat: 34.1, lng: -117.85 } };
  const st = [];
  for (let i = 0; i < 20; i++) st.push({ id: 's' + i, lat: 34.0 + ((i * 7) % 20) / 100, lng: -118.3 + ((i * 13) % 20) * 0.025, tags: [] });
  const r = ctx.phloAssignStops(st, [A, B]);
  const lngs = d => st.filter(s => r[s.id].driverId === d).map(s => s.lng);
  eq([lngs('A').length > 0, lngs('B').length > 0, Math.max(...lngs('A')) < Math.min(...lngs('B'))], [true, true, true], 'routes sharing an area do not interleave');
}
// A driver with no area only takes stops no area reaches.
{
  const area = [[34, -118.2], [34, -118], [34.1, -118], [34.1, -118.2]];
  const r = ctx.phloAssignStops([{ id: 'in', lat: 34.05, lng: -118.1, tags: [] }, { id: 'out', lat: 34.6, lng: -118.1, tags: [] }],
    [{ id: 'A', areas: [area], types: [], start: { lat: 34.05, lng: -118.1 } }, { id: 'N', areas: [], types: [], start: { lat: 34.05, lng: -118.1 } }]);
  eq([r.in.driverId, r.out.driverId], ['A', 'N'], 'drivers without an area take the stops no area reaches');
}
// Fixed stops (already planned) stay put and are not flagged as manual.
eq(JSON.parse(JSON.stringify(ctx.phloAssignStops([{ id: 'f', lat: 34, lng: -118, driverId: 'A', fixed: true }], [{ id: 'A', areas: [], types: [] }]))), { f: { driverId: 'A', flags: [] } }, 'fixed stops');
// Ordering: points on a line visited in line order.
const line = [{ lat: 34, lng: -118.3 }, { lat: 34, lng: -118.1 }, { lat: 34, lng: -118.4 }, { lat: 34, lng: -118.2 }];
eq(ctx.phloOrderStops(line, { lat: 34, lng: -118 }, null), [1, 3, 0, 2], 'order from start');
eq(ctx.phloOrderStops(line, { lat: 34, lng: -118 }, { lat: 34, lng: -118 }).length, 4, 'order with end');
eq(ctx.phloOrderStops([{ lat: 1, lng: 1 }], null, null), [0], 'single stop');
const box = []; for (let i = 0; i < 30; i++) box.push({ lat: 34 + ((i * 7) % 10) / 100, lng: -118 + ((i * 3) % 10) / 100 });
const ord = ctx.phloOrderStops(box, { lat: 34, lng: -118 }, null);
eq(ord.slice().sort((a, b) => a - b), box.map((p, i) => i), 'order visits every stop once');
const routeLen = o => o.reduce((t, k, i) => t + ctx.phloEstMin(i ? box[o[i - 1]] : { lat: 34, lng: -118 }, box[k]), 0);
eq(routeLen(ord) < routeLen(box.map((p, i) => i)) * 0.7, true, 'ordered route is much shorter than list order');
eq(JSON.parse(JSON.stringify(ctx.phloRouteSegments(3, true))), [{ from: -1, via: [0, 1, 2], to: 'end' }], 'segments with end');
eq(JSON.parse(JSON.stringify(ctx.phloRouteSegments(3, false))), [{ from: -1, via: [0, 1], to: 2 }], 'segments without end');
eq(JSON.parse(JSON.stringify(ctx.phloRouteSegments(7, false, 2))).map(s => [s.from, s.via.join(''), s.to]), [[-1, '01', 2], [2, '34', 5], [5, '', 6]], 'long route split');
eq(JSON.parse(JSON.stringify(ctx.phloRouteSegments(6, true, 2))).map(s => [s.from, s.via.join(''), s.to]), [[-1, '01', 2], [2, '34', 5], [5, '', 'end']], 'long route split with end');
const sch = ctx.phloSchedule([10, 20, 30, 15], 3, { availableFrom: '11:30', availableTo: '12:45', lunchFrom: '12:00', lunchTo: '12:30', speed: 'NORMAL' }, { serviceMin: 5 });
eq([sch.etas, sch.finish, sch.driveMin, sch.late, sch.lunchBefore], [['11:40', '12:35', '13:10'], '13:30', 75, [2], 1], 'schedule with lunch and late stop');
eq(ctx.phloSchedule([10, 10], 2, { speed: 'SLOW' }, { serviceMin: 0, dayStart: '08:00' }).etas, ['08:12', '08:23'], 'slow driver');
eq(JSON.parse(JSON.stringify(ctx.phloDecodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'))), [{ lat: 38.5, lng: -120.2 }, { lat: 40.7, lng: -120.95 }, { lat: 43.252, lng: -126.453 }], 'decode polyline');
eq([ctx.phloRandomPin([12, 7, 3, 9, 0, 5]), ctx.phloRandomPin([1, 1, 1, 1, 1, 1]), ctx.phloRandomPin([1, 2, 3, 4, 5, 6]), ctx.phloRandomPin([9, 8, 7, 6, 5, 4]), ctx.phloRandomPin([8, 9, 0, 1, 2, 3])],
  ['273905', null, null, null, null], 'random PINs skip easy ones');
eq([ctx.phloUsername(' Ana  Maria'), ctx.phloUsername("O'Neil")], ['ana', 'oneil'], 'usernames');
eq(ctx.phloNavUrl({ lat: 34.1, lng: -118.2 }), 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=34.1,-118.2', 'nav link');
eq([ctx.phloCheckUpdate({ status: 'delivered', methods: ['door'] }).length, ctx.phloCheckUpdate({ status: 'delivered', methods: ['approved'] }).length,
  ctx.phloCheckUpdate({ status: 'failed' }).length, ctx.phloCheckUpdate({ status: 'delivered', copayCollected: '5.5' }).length, ctx.phloCheckUpdate({}).length], [0, 1, 1, 0, 1], 'stop update checks');

/* ---------- dispatch server (apps-script-dispatch/Server.gs) ---------- */
{
  const srv = require('./fake-apps-script')({ adminTokens: { good: 'yourphlo@gmail.com', other: 'someone@gmail.com' } });
  const sha = (salt, pin) => require('crypto').createHash('sha256').update(salt + ':' + pin).digest('hex');
  eq(srv.post({ action: 'admin.syncDrivers', googleToken: 'other', drivers: [] }).error, 'This Google account cannot send routes.', 'server: only admins');
  eq(srv.post({ action: 'admin.syncDrivers', googleToken: 'good', drivers: [
    { id: 'a', name: 'Ana Ruiz', username: 'ana', salt: 's1', hash: sha('s1', '4321') }, { id: 'b', name: 'Bo', username: 'bo', salt: 's2', hash: sha('s2', '1111') }] }).accounts, 2, 'server: sync drivers');
  eq(srv.post({ action: 'driver.login', username: 'Ana', pin: '0000' }).error, 'Wrong name or PIN.', 'server: wrong pin');
  const login = srv.post({ action: 'driver.login', username: 'Ana', pin: '4321' });
  eq([login.ok, login.name, login.session.length], [true, 'Ana Ruiz', 64], 'server: login');
  for (let i = 0; i < 5; i++) srv.post({ action: 'driver.login', username: 'bo', pin: '9' });
  eq(srv.post({ action: 'driver.login', username: 'bo', pin: '1111' }).error, 'Too many wrong tries. Wait 15 minutes and try again.', 'server: lockout');
  const stop = (id, seq) => ({ id, seq, name: id + ',DOE', address: '1 A St', lat: 34, lng: -118, eta: '09:10' });
  eq(srv.post({ action: 'admin.publish', googleToken: 'good', date: '2026-10-22', routes: [
    { driverId: 'a', driverName: 'Ana Ruiz', stops: [stop('rx1', 1), stop('rx2', 2)] }, { driverId: 'b', driverName: 'Bo', stops: [stop('rx3', 1)] }] }).routes, 2, 'server: publish');
  const mine = srv.post({ action: 'driver.route', session: login.session });
  eq([mine.date, mine.route.stops.map(s => s.id)], ['2026-10-22', ['rx1', 'rx2']], 'server: driver sees only their next route');
  eq(srv.post({ action: 'driver.update', session: login.session, date: '2026-10-22', stopId: 'rx3', update: { status: 'delivered' } }).error, 'That stop is not on your route.', 'server: no updates to other routes');
  const png = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');
  const up = srv.post({ action: 'driver.update', session: login.session, date: '2026-10-22', stopId: 'rx1',
    update: { status: 'delivered', methods: ['approved', 'bogus'], approvedBy: 'Kim', copayCollected: '5.00', signature: png } });
  eq([up.update.methods, up.update.approvedBy, !!up.update.signatureId, up.update.photoId], [['approved'], 'Kim', true, ''], 'server: save update');
  eq(srv.post({ action: 'driver.file', session: login.session, date: '2026-10-22', fileId: up.update.signatureId }).dataUrl, png, 'server: driver reads own file');
  const st = srv.post({ action: 'admin.status', googleToken: 'good', date: '2026-10-22' });
  eq([st.plan.routes.length, Object.keys(st.updates)], [2, ['rx1']], 'server: admin status');
  eq(srv.post({ action: 'admin.file', googleToken: 'good', fileId: up.update.signatureId }).dataUrl, png, 'server: admin reads file');
  srv.post({ action: 'admin.syncDrivers', googleToken: 'good', drivers: [{ id: 'b', name: 'Bo', username: 'bo', salt: 's2', hash: sha('s2', '1111') }] });
  eq(srv.post({ action: 'driver.route', session: login.session }).error, 'Please sign in again.', 'server: removed driver is signed out');
  eq(srv.post('not json').error, 'Bad request.', 'server: bad request');
}

eq(ctx.phloCheckUpdate({ status: 'delivered', methods: ['door'] }, { leaveApproved: true }).length, 1, 'pharmacy-approved drop-off needs a photo');
eq([ctx.phloCheckUpdate({ status: 'delivered', methods: ['door'] }, { leaveApproved: true, hasPhoto: true }).length,
  ctx.phloCheckUpdate({ status: 'delivered' }, { leaveApproved: true, hasSignature: true }).length], [0, 0], 'photo or signature is enough');
eq(ctx.phloPatientKey('5147457, 5147468,RIVERA,GILBERTO, & AYALA,ISABEL', '12 N Oak Ave Apt 3 Town CA 91000'), 'RIVERAGILBERTO|12|91000|3|O', 'patient key');
eq(ctx.phloPatientKey('1000001,DOE,JANE', ''), '', 'no key without an address');
eq(JSON.parse(JSON.stringify(ctx.phloStorePhones([['10/19/2026', '1000001', 'DOE,JANE|1 A ST TOWN CA 91000|(626) 555-0100'], ['10/19/2026', '1000002', 'ROE,BO, 2 B ST TOWN CA 91000']],
  { code: 'T', cols: { date: 0, id: 1, name: 2 } }, delivery))), { 1000001: '(626) 555-0100' }, 'phone numbers from a sheet');

/* ---------- patient texts (web/texts.js) ---------- */
eq([ctx.phloE164('(626) 555-0100'), ctx.phloE164('1-626-555-0100'), ctx.phloE164('+44 20 7946 0958'), ctx.phloE164('555-0100'), ctx.phloE164('')],
  ['+16265550100', '+16265550100', '+442079460958', '', ''], 'phone numbers');
eq(ctx.phloPhoneShow('+16265550100'), '(626) 555-0100', 'phone shown');
const pr = t => { const r = ctx.phloParseReply(t); return [r.choice, r.detail]; };
eq([pr('1 Friday after 3pm'), pr(' 3. Maria, daughter'), pr('２'), pr('四'), pr('5'), pr('10 am tomorrow'), pr('who is this?')],
  [['redeliver', 'Friday after 3pm'], ['someone', 'Maria, daughter'], ['refuse', ''], ['door', ''], ['mailbox', ''], [null, '10 am tomorrow'], [null, 'who is this?']], 'read replies');
eq([ctx.phloReplyNeedsDetail('redeliver', ''), ctx.phloReplyNeedsDetail('someone', 'Ana'), ctx.phloReplyNeedsDetail('refuse', '')], [true, false, false], 'replies that need more');
eq(ctx.phloRedeliverText('2026-10-24', 'afternoon'), 'Sat 10/24, afternoon (12-5 PM)', 'redeliver words');
eq(ctx.phloRtsText('1000001', 'DOE,JANE', 'pickup'), 'Please RTS to RX [1000001, DOE,JANE]: PT will pick up @ RX instead', 'RTS words');
eq(ctx.phloRtsText('1000001', 'DOE,JANE', 'other', 'wrong address'), 'Please RTS to RX [1000001, DOE,JANE]: wrong address', 'RTS other');
eq(ctx.phloSms('es', 'got_redeliver', { detail: 'viernes' }), 'Gracias. Le avisamos a su farmacia que entregue otro día: viernes.', 'Spanish text');
eq(ctx.phloSms('xx', 'closed').indexOf('This delivery'), 0, 'unknown language falls back to English');
// Every language has every message and page word, and the same {slots}.
const slots = t => (String(t).match(/\{\w+\}/g) || []).sort().join();
ctx.PHLO_LANGS.forEach(l => {
  [['PHLO_SMS', ctx.PHLO_SMS], ['PHLO_PAGE', ctx.PHLO_PAGE]].forEach(([n, set]) => {
    const miss = Object.keys(set.en).filter(k => !set[l.code] || !set[l.code][k] || slots(set[l.code][k]) !== slots(set.en[k]));
    eq(miss, [], n + ' complete for ' + l.code);
  });
});
{
  const route = { start: '09:00', serviceMin: 10, stops: [{ id: 'a', eta: '09:20' }, { id: 'b', eta: '09:50' }, { id: 'c', eta: '10:30' }, { id: 'd', eta: '11:30' }] };
  const due = (done, started, now) => JSON.parse(JSON.stringify(ctx.phloTextDue(route, done, started, now, 30))).map(d => d.id + ':' + d.min);
  eq(due({}, null, 9 * 60), [], 'no texts before the driver starts');
  eq(due({}, 9 * 60, 9 * 60), ['a:20'], 'started on time: first stop texted');
  eq(due({}, 9 * 60 + 20, 9 * 60 + 20), ['a:20'], 'started 20 min late: first stop moves later too');
  eq(due({}, 9 * 60 + 20, 9 * 60 + 40), ['a:5', 'b:30'], 'later: next stop comes into the 30 minutes');
  eq(due({ a: 9 * 60 + 30 }, 9 * 60, 9 * 60 + 30), ['b:20'], 'on time after stop a');
  eq(due({ a: 10 * 60 + 15 }, 9 * 60, 10 * 60 + 15), ['b:20'], 'running 45 min late: next stop 20 min away');
  eq(due({ a: 10 * 60 + 15 }, 9 * 60, 10 * 60 + 45), ['b:5', 'c:30'], 'running late: a passed-due stop is still texted');
  eq(due({ b: 9 * 60 + 40 }, 9 * 60, 9 * 60 + 40), ['c:30'], 'a stop skipped before the last one recorded is not texted');
}

/* ---------- texting on the dispatch server ---------- */
{
  const srv = require('./fake-apps-script')({ adminTokens: { good: 'yourphlo@gmail.com' }, quo: true, now: '2026-10-22T08:00:00', optedOut: ['+16265550199'] });
  const sha = (salt, pin) => require('crypto').createHash('sha256').update(salt + ':' + pin).digest('hex');
  srv.post({ action: 'admin.syncDrivers', googleToken: 'good', drivers: [
    { id: 'a', name: 'Ana Ruiz', username: 'ana', salt: 's1', hash: sha('s1', '4321'), mobile: '626-555-0001' },
    { id: 'b', name: 'Bo', username: 'bo', salt: 's2', hash: sha('s2', '1111') }] });
  const set = srv.post({ action: 'admin.textSettings', googleToken: 'good', set: { leadMin: 30, pharmacies: {
    VALLEY: { phone: '626 555 0300', email: 'rx@example.com', pin: '2468' }, LV: { pin: '12' } } } });
  eq(set.error, 'A pharmacy PIN must be 4 to 8 digits (LV).', 'texting: bad pharmacy PIN refused');
  const settings = srv.post({ action: 'admin.textSettings', googleToken: 'good', set: { leadMin: 30, pharmacies: { VALLEY: { phone: '626 555 0300', email: 'rx@example.com', pin: '2468' } } } });
  eq([settings.ready, settings.from, settings.pharmacies.VALLEY, /\/exec\?key=\w{32}$/.test(settings.hookUrl), srv.triggers],
    [true, '(626) 555-0000', { phone: '+16265550300', email: 'rx@example.com', hasPin: true }, true, ['textingTick']], 'texting: settings + 5-minute timer');
  const hookKey = settings.hookUrl.split('key=')[1];
  const stop = (id, seq, eta, phone, lang, store) => ({ id, seq, name: id.slice(2) + ',DOE,JANE', address: seq + ' A St', store: store || 'VALLEY', eta, phone, lang, key: 'K' + id, tags: [] });
  const pub = srv.post({ action: 'admin.publish', googleToken: 'good', date: '2026-10-22', routes: [
    { driverId: 'a', driverName: 'Ana Ruiz', start: '09:00', serviceMin: 10, stops: [
      stop('rx1000001', 1, '09:20', '(626) 555-0101', 'es'), stop('rx1000002', 2, '09:50', '6265550102', 'en'),
      stop('rx1000003', 3, '10:30', '', 'en'), stop('rx1000004', 4, '11:30', '626-555-0199', 'en', 'LV')] }] });
  eq(pub.texting, true, 'texting: publish');
  const route = srv.post({ action: 'driver.route', session: srv.post({ action: 'driver.login', username: 'ana', pin: '4321' }).session });
  eq(route.route.stops.some(s => 'phone' in s || 'lang' in s), false, 'texting: drivers never get phone numbers');
  eq(srv.post({ action: 'admin.patients', googleToken: 'good', keys: ['Krx1000001', 'nope'] }).patients, { Krx1000001: { phone: '+16265550101', lang: 'es' } }, 'texting: phone + language saved for next time');

  const ana = srv.post({ action: 'driver.login', username: 'ana', pin: '4321' }).session;
  srv.setNow('2026-10-22T08:55:00'); srv.clearTickCache(); srv.run('textingTick');
  eq(srv.sms.length, 0, 'texting: nothing before the driver starts');
  srv.post({ action: 'driver.start', session: ana, date: '2026-10-22' });
  eq(srv.sms.map(m => m.to), ['+16265550101'], 'texting: starting texts the first stop');
  eq(/^Entrega de farmacia PHLO: su chofer llegará en unos 20 minutos \(alrededor de las 9:15 AM\)/.test(srv.sms[0].body), true, 'texting: in Spanish, with minutes and time');
  const token = srv.sms[0].body.match(/#t=(\w+)/)[1];
  eq(srv.sms[0].body.indexOf('https://yourphlo.github.io/phlo/#t=261022') >= 0, true, 'texting: reply link');
  eq([srv.sms[0].auth, srv.sms[0].from], ['quokey', '+16265550000'], 'texting: Quo API key and number');
  srv.post({ action: 'driver.start', session: ana, date: '2026-10-22' });
  eq(srv.sms.length, 1, 'texting: each patient is texted once');

  // Patient 1 answers "4" (front door) by text: the pharmacy is asked, the driver told.
  srv.sms.length = 0;
  eq(srv.quo({ from: '+16265550101', body: '4', key: 'wrong' }), { ok: true }, 'texting: wrong hook key ignored');
  eq(srv.sms.length, 0, 'texting: nothing done for a wrong key');
  srv.quo({ from: '+16265550101', body: '4', key: hookKey, id: 'ACdoor' });
  eq(srv.sms.map(m => m.to), ['+16265550101', '+16265550300', '+16265550001'], 'texting: door request answers patient, asks pharmacy, tells driver');
  srv.quo({ from: '+16265550101', body: '4', key: hookKey, id: 'ACdoor' });
  eq(srv.sms.length, 3, 'texting: a resent Quo event is handled once');
  delete srv.cache.quoIn_ACdoor;
  srv.quo({ from: '+16265550101', body: '4', key: hookKey, id: 'ACdoor' });
  eq(srv.sms.length, 3, 'texting: a resent Quo event is handled once (after the cache expires)');
  eq(srv.sms[0].body.indexOf('Gracias. Su farmacia debe aprobar'), 0, 'texting: answer in Spanish');
  eq(srv.sms[1].body.indexOf('RX 1000001') > 0 && srv.sms[1].body.indexOf('DOE') < 0, true, 'texting: pharmacy text has the RX number, not the name');
  eq([srv.mail.length, srv.mail[0].to], [1, 'rx@example.com'], 'texting: pharmacy emailed');
  eq(srv.sms[2].body, 'PHLO stop 1 (1000001,DOE,JANE): patient says: Leave at front door, no signature (waiting for the pharmacy\'s OK)', 'texting: driver text');
  let dr = srv.post({ action: 'driver.route', session: ana });
  eq([dr.texts.rx1000001.request.choice, dr.texts.rx1000001.approval.status], ['door', 'pending'], 'texting: driver app shows the request');

  // The pharmacy signs in and approves; patient and driver are told.
  eq(srv.post({ action: 'rx.login', store: 'valley', pin: '0000' }).error, 'Wrong pharmacy or PIN.', 'texting: pharmacy wrong PIN');
  const rx = srv.post({ action: 'rx.login', store: 'valley', pin: '2468' }).session;
  eq(srv.post({ action: 'driver.route', session: rx }).error, 'Please sign in again.', 'texting: pharmacy session is not a driver');
  const day = srv.post({ action: 'rx.day', session: rx, date: '2026-10-22' });
  eq(day.stops.map(s => s.id), ['rx1000001', 'rx1000002', 'rx1000003'], 'texting: pharmacy sees only its own stops');
  eq(srv.post({ action: 'rx.approve', session: rx, date: '2026-10-22', stopId: 'rx1000001', ok: true, by: 'Jane Kim' }).error,
    'Type the name and position of the pharmacy staff who approve it.', 'texting: approval needs name + position');
  eq(srv.post({ action: 'rx.approve', session: rx, date: '2026-10-22', stopId: 'rx1000004', ok: true, by: 'J', position: 'RPh' }).error,
    'That stop is not one of your deliveries.', 'texting: pharmacy cannot approve another store\'s stop');
  srv.sms.length = 0;
  srv.post({ action: 'rx.approve', session: rx, date: '2026-10-22', stopId: 'rx1000001', ok: true, by: 'Jane Kim', position: 'Pharmacist' });
  eq(srv.sms.map(m => m.to), ['+16265550101', '+16265550001'], 'texting: approval texts patient and driver');
  eq(srv.sms[0].body.indexOf('Su farmacia aprobó dejar su entrega en la puerta principal'), 0, 'texting: approval in Spanish');
  eq(srv.sms[1].body.indexOf('approved by Jane Kim, Pharmacist') > 0, true, 'texting: driver told who approved');
  dr = srv.post({ action: 'driver.route', session: ana });
  eq([dr.texts.rx1000001.approval.status, dr.texts.rx1000001.approval.by, dr.texts.rx1000001.approval.position], ['approved', 'Jane Kim', 'Pharmacist'], 'texting: driver app shows the approval');

  // Driver finishes stop 1 late: stop 2 is texted. Patient 2 answers "1", then the day.
  srv.setNow('2026-10-22T09:45:00');
  srv.sms.length = 0;
  srv.post({ action: 'driver.update', session: ana, date: '2026-10-22', stopId: 'rx1000001', update: { status: 'delivered', methods: ['door'] } });
  eq(srv.sms.map(m => m.to + ' ' + m.body.slice(0, 64)), ['+16265550102 PHLO pharmacy delivery: your driver is about 20 minutes away (ar'], 'texting: next stop texted after a late stop');
  srv.sms.length = 0;
  srv.quo({ from: '(626) 555-0102', body: '1', key: hookKey });
  eq(srv.sms[0].body.indexOf('Thank you. What day and time work for you?'), 0, 'texting: "1" alone asks for the day');
  srv.quo({ from: '+16265550102', body: 'Saturday morning', key: hookKey });
  let st = srv.post({ action: 'admin.status', googleToken: 'good', date: '2026-10-22' });
  eq([st.texts.stops.rx1000002.request.choice, st.texts.stops.rx1000002.request.detail], ['redeliver', 'Saturday morning'], 'texting: the day comes in the next text');
  eq(srv.sms.slice(1).map(m => m.to + ' ' + m.body), ['+16265550102 Thank you. We told your pharmacy to redeliver: Saturday morning.',
    '+16265550001 PHLO stop 2 (1000002,DOE,JANE): patient says: Not home: redeliver Saturday morning'], 'texting: answer + driver told');
  eq(st.texts.stops.rx1000002.log.map(l => l.dir), ['out', 'in', 'out', 'in', 'out'], 'texting: office sees the whole conversation');

  // The office asks the driver to bring stop 3 back.
  srv.sms.length = 0;
  eq(srv.post({ action: 'admin.message', googleToken: 'good', date: '2026-10-22', stopId: 'rx1000003', reason: 'other' }).error, 'Type the reason.', 'texting: other needs words');
  const msg = srv.post({ action: 'admin.message', googleToken: 'good', date: '2026-10-22', stopId: 'rx1000003', reason: 'repack' }).msg;
  eq([msg.text, msg.texted, srv.sms[0].to], ['Please RTS to RX [1000003, DOE,JANE]: RX needs to repack/fill more meds', true, '+16265550001'], 'texting: RTS message texted to driver');
  const rxMsg = srv.post({ action: 'rx.message', session: rx, date: '2026-10-22', stopId: 'rx1000002', reason: 'pickup', by: 'Jane' }).msg;
  eq(rxMsg.from, 'Pharmacy VALLEY (Jane)', 'texting: pharmacy messages the driver');
  dr = srv.post({ action: 'driver.route', session: ana });
  eq(dr.msgs.map(m => m.stopId), ['rx1000003', 'rx1000002'], 'texting: driver app lists messages');
  eq(srv.post({ action: 'driver.ack', session: ana, date: '2026-10-22', msgId: msg.id }).msg.readAt > '', true, 'texting: driver marks it read');

  // The reply page.
  let pv = srv.post({ action: 'patient.get', token });
  eq([pv.lang, pv.request.choice, pv.approval.status, pv.done, pv.expired], ['es', 'door', 'approved', 'delivered', false], 'texting: reply page state');
  eq(srv.post({ action: 'patient.get', token: '261022ffffffffffffff' }).error, 'This link is not right.', 'texting: bad link');
  const tok4 = st.texts.stops.rx1000004.token;
  eq(srv.post({ action: 'patient.reply', token: tok4, choice: 'someone', data: { name: '' } }).error, 'Type the name of the person.', 'texting: page needs a name');
  srv.sms.length = 0;
  pv = srv.post({ action: 'patient.reply', token: tok4, choice: 'someone', data: { name: 'Maria', relation: 'daughter' } });
  eq([pv.request.choice, pv.request.detail], ['someone', 'Maria (daughter)'], 'texting: page answer saved');
  eq(srv.sms.map(m => m.to), ['+16265550001'], 'texting: page answer tells the driver (no text back to the patient)');
  pv = srv.post({ action: 'patient.reply', token: tok4, choice: 'redeliver', data: { date: '2026-10-24', time: 'evening' } });
  eq(pv.request.detail, 'Sat 10/24, evening (5-8 PM)', 'texting: page redelivery');
  eq(srv.post({ action: 'patient.lang', token: tok4, lang: 'vi' }).lang, 'vi', 'texting: patient picks a language');
  eq(srv.post({ action: 'admin.patients', googleToken: 'good', keys: ['Krx1000004'] }).patients.Krx1000004.lang, 'vi', 'texting: language kept for next time');

  // Opted-out numbers, a finished stop, and a stranger.
  const sent = srv.post({ action: 'admin.textNow', googleToken: 'good', date: '2026-10-22', stopId: 'rx1000004' }).sent;
  eq([sent.ok, sent.optOut], [false, true], 'texting: STOP-ed number not texted');
  eq(srv.post({ action: 'admin.status', googleToken: 'good', date: '2026-10-22' }).texts.stops.rx1000004.optOut, true, 'texting: STOP-ed number remembered');
  srv.sms.length = 0;
  srv.quo({ from: '+16265550101', body: '2', key: hookKey });
  eq(srv.sms.map(m => m.body), ['Esta entrega ya terminó. Llame a su farmacia si tiene preguntas.'], 'texting: finished stop answered');
  srv.sms.length = 0;
  srv.quo({ from: '+13105550000', body: '1', key: hookKey });
  eq(srv.sms.length, 0, 'texting: unknown numbers get no answer');

  // Texting not set up: nothing goes out, and the office sees why.
  const off = require('./fake-apps-script')({ adminTokens: { good: 'yourphlo@gmail.com' }, now: '2026-10-22T08:00:00' });
  off.post({ action: 'admin.publish', googleToken: 'good', date: '2026-10-22', routes: [{ driverId: 'a', driverName: 'A', start: '09:00', stops: [stop('rx1', 1, '08:20', '6265550101', 'en')] }] });
  eq(off.post({ action: 'admin.textNow', googleToken: 'good', date: '2026-10-22', stopId: 'rx1' }).sent.err, 'Texting is not set up yet (Quo).', 'texting: not set up');
  eq(off.sms.length, 0, 'texting: nothing sent without Quo');
}

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
