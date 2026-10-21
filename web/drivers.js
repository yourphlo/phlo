/* PHLO driver profiles: field rules, checks and the drivers export.
 * Pure functions (no page or Google code) so test/run.js can check them in Node. */

var DRIVER_SPEEDS = [
  { value: 'SLOW', label: 'SLOW (10%)', percent: 10 },
  { value: 'NORMAL', label: 'NORMAL (100%)', percent: 100 },
  { value: 'FAST', label: 'FAST (190%)', percent: 190 }
];

var DRIVER_HEADERS = ['Driver Name', 'Start Address', 'End Address', 'Availability Start', 'Availability End',
  'Mobile number', 'Capacity', 'Types', 'Driving Speed', 'Lunch Break Start', 'Lunch Break End'];

function phloCleanText(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

/** "FRIDGE, cash ,FRIDGE" -> ['FRIDGE', 'cash']. Case sensitive: 'Fridge' and 'FRIDGE' are different types. */
function phloParseTypes(v) {
  var list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,;\n]/);
  var out = [];
  list.forEach(function (t) {
    t = phloCleanText(t);
    if (t && out.indexOf(t) < 0) out.push(t);
  });
  return out;
}

/** "9:5" / "09:05" / "905" / "9:05 am" / "1:30 PM" -> "09:05" / "13:30"; '' when empty; null when not a time. */
function phloParseTime(v) {
  var s = phloCleanText(v).toUpperCase();
  if (!s) return '';
  var m = s.match(/^(\d{1,2})(?::?(\d{2}))?\s*([AP])?\.?M?\.?$/);
  if (!m) return null;
  var h = +m[1], min = m[2] ? +m[2] : 0;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === 'P' && h < 12) h += 12;
    if (m[3] === 'A' && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return (h < 10 ? '0' : '') + h + ':' + (min < 10 ? '0' : '') + min;
}

function phloMinutes(t) { var p = t.split(':'); return +p[0] * 60 + +p[1]; }

/** A Google Maps pin for an address: {address, lat, lng, placeId}. Kept only while it still matches
 * the address text, so editing an address by hand drops its old pin. */
function phloNormalizePin(pin, address) {
  if (!pin || typeof pin !== 'object' || !address) return null;
  var lat = +pin.lat, lng = +pin.lng;
  if (phloCleanText(pin.address) !== address || !isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { address: address, lat: lat, lng: lng, placeId: phloCleanText(pin.placeId) };
}

/** Google Maps link for an address, pointing at the exact place when it is pinned. */
function phloMapsUrl(address, pin) {
  var u = 'https://www.google.com/maps/search/?api=1&query=';
  if (pin) return u + pin.lat + ',' + pin.lng + (pin.placeId ? '&query_place_id=' + encodeURIComponent(pin.placeId) : '');
  return u + encodeURIComponent(address);
}

/** Tidies a driver from the form or from storage. Keeps bad times as typed so the checks can point at them. */
function phloNormalizeDriver(d) {
  d = d || {};
  var time = function (v) { var t = phloParseTime(v); return t === null ? phloCleanText(v) : t; };
  var cap = phloCleanText(d.capacity);
  var speed = phloCleanText(d.speed).toUpperCase();
  var start = phloCleanText(d.startAddress), end = phloCleanText(d.endAddress);
  return {
    id: d.id || ('d' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
    name: phloCleanText(d.name),
    startAddress: start,
    startPin: phloNormalizePin(d.startPin, start),
    endAddress: end,
    endPin: phloNormalizePin(d.endPin, end),
    availableFrom: time(d.availableFrom),
    availableTo: time(d.availableTo),
    mobile: phloCleanText(d.mobile),
    capacity: /^\d+$/.test(cap) ? +cap : cap,
    types: phloParseTypes(d.types),
    speed: DRIVER_SPEEDS.some(function (s) { return s.value === speed; }) ? speed : 'NORMAL',
    lunchFrom: time(d.lunchFrom),
    lunchTo: time(d.lunchTo)
  };
}

/** Problems that stop a driver from being saved: [{field, message}]. `others` = the other saved drivers. */
function phloValidateDriver(d, others) {
  var errs = [];
  var add = function (field, message) { errs.push({ field: field, message: message }); };
  if (!d.name) add('name', 'Driver name is required.');
  else if ((others || []).some(function (o) { return o.id !== d.id && o.name.toLowerCase() === d.name.toLowerCase(); })) {
    add('name', 'Another driver is already called "' + d.name + '".');
  }
  if (!d.startAddress) add('startAddress', 'Start address is required.');

  // needBoth: false lets one side stay empty (availability can be just a start or just an end time).
  var pair = function (from, to, label, needBoth) {
    var a = d[from], b = d[to], ok = true;
    if (a && phloParseTime(a) === null) { add(from, label + ' start "' + a + '" is not a time.'); ok = false; }
    if (b && phloParseTime(b) === null) { add(to, label + ' end "' + b + '" is not a time.'); ok = false; }
    if (ok && needBoth && !!a !== !!b) { add(a ? to : from, label + ' needs both a start and an end time.'); ok = false; }
    if (ok && a && b && phloMinutes(b) <= phloMinutes(a)) { add(to, label + ' must end after it starts.'); ok = false; }
    return ok;
  };
  var shift = pair('availableFrom', 'availableTo', 'Availability', false);
  var lunch = pair('lunchFrom', 'lunchTo', 'Lunch break', true) && d.lunchFrom && d.lunchTo;
  if (shift && lunch && ((d.availableFrom && phloMinutes(d.lunchFrom) < phloMinutes(d.availableFrom)) ||
      (d.availableTo && phloMinutes(d.lunchTo) > phloMinutes(d.availableTo)))) {
    add('lunchFrom', 'Lunch break should be inside the availability hours.');
  }

  if (d.capacity !== '' && !(typeof d.capacity === 'number' && d.capacity > 0)) add('capacity', 'Capacity must be a whole number above 0.');
  if (d.mobile) {
    var digits = d.mobile.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15 || /[^\d\s()+.\-]/.test(d.mobile)) add('mobile', 'Mobile number "' + d.mobile + '" does not look like a phone number.');
  }
  return errs;
}

/** Rows for the drivers .xlsx: header row, then one row per driver. */
function phloDriverRows(drivers) {
  return [DRIVER_HEADERS].concat(drivers.map(function (d) {
    var speed = DRIVER_SPEEDS.filter(function (s) { return s.value === d.speed; })[0] || DRIVER_SPEEDS[1];
    return [d.name, d.startAddress, d.endAddress, d.availableFrom, d.availableTo, d.mobile,
      d.capacity === '' ? '' : d.capacity, d.types.join(', '), speed.label, d.lunchFrom, d.lunchTo];
  }));
}

/** Which drivers work on `iso` (YYYY-MM-DD): that date's saved pick, else the most recent earlier pick, else everyone. */
function phloRosterFor(data, iso) {
  var ids = data.drivers.map(function (d) { return d.id; });
  var roster = data.roster || {};
  var pick = roster[iso];
  if (!pick) {
    var earlier = Object.keys(roster).filter(function (k) { return k < iso; }).sort();
    pick = earlier.length ? roster[earlier[earlier.length - 1]] : ids;
  }
  return pick.filter(function (id) { return ids.indexOf(id) >= 0; });
}

/** The saved drivers file: {version, updatedAt, drivers, roster}. Tolerates missing or old fields. */
function phloDriversData(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  var roster = {};
  Object.keys(raw.roster || {}).forEach(function (k) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Array.isArray(raw.roster[k])) roster[k] = raw.roster[k].map(String);
  });
  return {
    version: 1,
    updatedAt: raw.updatedAt || '',
    drivers: (Array.isArray(raw.drivers) ? raw.drivers : []).map(phloNormalizeDriver),
    roster: roster
  };
}
