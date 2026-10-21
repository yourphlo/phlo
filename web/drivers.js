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

/** "Ana Maria Ruiz" -> "ana": a sign-in name for the driver app (lowercase letters and digits). */
function phloUsername(v) { return phloCleanText(v).split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, ''); }

/** The name a driver signs in to the driver app with: their own username, else their first name. */
function phloLoginName(d) { return d.username || phloUsername(d.name); }

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
    lunchTo: time(d.lunchTo),
    username: phloCleanText(d.username).toLowerCase().replace(/[^a-z0-9]/g, ''),
    pinSalt: /^[0-9a-f]{8,64}$/.test(d.pinSalt || '') ? d.pinSalt : '',
    pinHash: /^[0-9a-f]{64}$/.test(d.pinHash || '') ? d.pinHash : '',
    areas: phloNormalizeAreas(d.areas),
    color: /^#[0-9a-f]{6}$/i.test(d.color || '') ? d.color.toLowerCase() : ''
  };
}

/** Problems that stop a driver from being saved: [{field, message}]. `others` = the other saved drivers.
 * `pin` = a new driver app PIN typed in the form ('' = keep the current one). */
function phloValidateDriver(d, others, pin) {
  var errs = [];
  var add = function (field, message) { errs.push({ field: field, message: message }); };
  if (!d.name) add('name', 'Driver name is required.');
  else if ((others || []).some(function (o) { return o.id !== d.id && o.name.toLowerCase() === d.name.toLowerCase(); })) {
    add('name', 'Another driver is already called "' + d.name + '".');
  }
  if (!d.startAddress) add('startAddress', 'Start address is required.');
  var login = phloLoginName(d);
  var clash = login && !errs.some(function (e) { return e.field === 'name'; }) && (others || []).filter(function (o) { return o.id !== d.id && phloLoginName(o) === login; })[0];
  if (clash) add('username', clash.name + ' already signs in to the driver app as "' + login + '". Give this driver another app username.');
  if (pin && !/^\d{4,6}$/.test(pin)) add('pin', 'The app PIN must be 4 to 6 digits.');

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

/* ---------- coverage areas (drawn on the Drivers map) ---------- */

// Area colours, one per driver. Picked to stand apart on a Google road map.
var AREA_COLORS = ['#d1495b', '#2b7bba', '#2a9d5c', '#e08a1e', '#7b4fb8', '#c2477f', '#178f8f', '#8a6d3b', '#4f6bd8', '#b5452a'];
var MAX_AREAS = 50;        // per driver
var MAX_AREA_POINTS = 500; // per area

/** Tidies a driver's drawn areas: a list of outlines, each [[lat, lng], ...] with at least 3 points.
 * Coordinates are rounded to 5 decimals (about 1 m); bad points and tiny outlines are dropped. */
function phloNormalizeAreas(areas) {
  if (!Array.isArray(areas)) return [];
  var out = [];
  areas.forEach(function (ring) {
    if (!Array.isArray(ring) || out.length >= MAX_AREAS) return;
    var pts = [];
    ring.forEach(function (p) {
      if (!Array.isArray(p)) return;
      var lat = +p[0], lng = +p[1];
      if (p[0] === '' || p[1] === '' || p[0] == null || p[1] == null) return;
      if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
      var q = [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5];
      var last = pts[pts.length - 1];
      if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
    });
    // A closed outline repeats its first point at the end; keep it open.
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length >= 3) out.push(pts.slice(0, MAX_AREA_POINTS));
  });
  return out;
}

/** Thins a hand-drawn line [[x, y], ...] (screen pixels) to the points that matter (Douglas-Peucker):
 * no kept line strays more than `tolerance` from the drawn one. */
function phloSimplifyPath(points, tolerance) {
  if (!points || points.length < 3) return (points || []).slice();
  var tol2 = tolerance * tolerance;
  var keep = new Array(points.length);
  keep[0] = keep[points.length - 1] = true;
  var stack = [[0, points.length - 1]];
  while (stack.length) {
    var seg = stack.pop(), a = points[seg[0]], b = points[seg[1]];
    var dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    var worst = -1, worstD = tol2;
    for (var i = seg[0] + 1; i < seg[1]; i++) {
      var p = points[i], t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      var ex = a[0] + t * dx - p[0], ey = a[1] + t * dy - p[1], d = ex * ex + ey * ey;
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst > 0) { keep[worst] = true; stack.push([seg[0], worst], [worst, seg[1]]); }
  }
  return points.filter(function (p, i) { return keep[i]; });
}

/** Colour for each driver ({id: '#rrggbb'}): its saved colour, else the next colour no one has yet. */
function phloDriverColors(drivers) {
  var used = {}, out = {}, next = 0;
  drivers.forEach(function (d) { if (d.color) { used[d.color.toLowerCase()] = true; out[d.id] = d.color; } });
  var free = AREA_COLORS.filter(function (c) { return !used[c]; });
  drivers.forEach(function (d) {
    if (out[d.id]) return;
    out[d.id] = free.length ? free[next % free.length] : AREA_COLORS[next % AREA_COLORS.length];
    next++;
  });
  return out;
}

/** The drawn areas as GeoJSON (opens in geojson.io, QGIS, etc.): one feature per driver with areas. */
function phloAreasGeoJson(drivers) {
  var colors = phloDriverColors(drivers);
  return {
    type: 'FeatureCollection',
    features: drivers.filter(function (d) { return d.areas && d.areas.length; }).map(function (d) {
      return {
        type: 'Feature',
        properties: { driver: d.name, color: colors[d.id], areas: d.areas.length, startAddress: d.startAddress },
        geometry: {
          type: 'MultiPolygon',
          coordinates: d.areas.map(function (ring) {
            var c = ring.map(function (p) { return [p[1], p[0]]; });
            c.push(c[0]);
            return [c];
          })
        }
      };
    })
  };
}
