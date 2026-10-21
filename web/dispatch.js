/* PHLO dispatch: who takes each stop, in what order, and when they get there.
 * Pure functions (no page or Google code) so test/run.js can check them in Node. */

var DISPATCH_DEFAULTS = { dayStart: '09:00', serviceMin: 4 };
// Travel time multiplier per driver speed (an assumption: a slow driver takes 15% longer).
var SPEED_FACTORS = { SLOW: 1.15, NORMAL: 1, FAST: 0.9 };
var GOOGLE_MAX_VIA = 25; // Google optimizes at most 25 stops between a start and an end

function phloToMin(t) { var p = String(t).split(':'); return +p[0] * 60 + +p[1]; }
function phloFromMin(m) {
  m = Math.round(m);
  var h = Math.floor(m / 60) % 24, mm = m % 60;
  return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
}

/** "13:05" -> "1:05 PM". */
function phloClock(t) {
  if (!t) return '';
  var m = phloToMin(t), h = Math.floor(m / 60) % 24;
  return ((h % 12) || 12) + ':' + phloFromMin(m).slice(3) + (h < 12 ? ' AM' : ' PM');
}

/** Straight-line distance in km. Points are {lat, lng}. */
function phloKm(a, b) {
  var r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rough driving minutes between two points (roads ~1.3x the straight line, ~35 km/h in town, +1 min to park). */
function phloEstMin(a, b) { var km = phloKm(a, b); return km < 0.01 ? 0 : km * 1.3 / 35 * 60 + 1; }

/** Is the point inside a drawn area ([[lat, lng], ...])? */
function phloInArea(p, ring) {
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    var yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
    if ((yi > p.lat) !== (yj > p.lat) && p.lng < (xj - xi) * (p.lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** How well Google found an address, from the result's types and partial_match:
 * 'ok' (a building or place), 'partial' (only the street, or Google had to guess part of it) or 'none'
 * (only a city, ZIP code, county, state or country: useless for a delivery). */
function phloGeocodeQuality(types, partial) {
  types = types || [];
  var exact = ['street_address', 'premise', 'subpremise', 'establishment', 'point_of_interest', 'intersection'];
  if (types.some(function (t) { return exact.indexOf(t) >= 0; })) return partial ? 'partial' : 'ok';
  if (types.indexOf('route') >= 0) return 'partial';
  return 'none';
}

/** RX numbers make a stop's id, so a driver's updates survive re-planning; otherwise name + address. */
function phloStopId(row) {
  var rx = phloRxNumbers(row[0]);
  if (rx.length) return 'rx' + rx.join('_');
  var s = String(row[0]) + '|' + String(row[1]), h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 'h' + (h >>> 0).toString(36);
}

/** What the driver needs from a master row's NOTES 2 ("$5.00-COMBO-FRIDGE-PAID"). */
function phloStopInfo(row) {
  var parts = String(row[3] || '').split('-').map(function (s) { return s.trim(); }).filter(Boolean);
  var copays = parts.filter(function (s) { return /^\$\d/.test(s); });
  var total = copays.reduce(function (t, s) { return t + parseFloat(s.slice(1)); }, 0);
  return {
    store: String(row[2] || ''),
    copay: total ? '$' + total.toFixed(2) : '',
    tags: parts.filter(function (s) { return !/^\$\d/.test(s); })
  };
}

/**
 * Picks a driver for every stop.
 * stops: [{id, lat, lng, tags, driverId (a manual pick, optional)}] (lat/lng missing = address not found)
 * drivers: [{id, areas, types, capacity, start: {lat, lng}}] (only the drivers working that day)
 * A tag that is also some driver's type (e.g. FRIDGE) means only drivers with that type can take the stop.
 * Returns {stopId: {driverId, flags: [...]}}. Flags: notFound, outside (in no one's area), overlap (in
 * several areas), type (no working driver has its types), manual (picked by hand).
 */
function phloAssignStops(stops, drivers) {
  var out = {}, load = {}, members = {};
  var allTypes = {};
  drivers.forEach(function (d) { load[d.id] = 0; members[d.id] = []; (d.types || []).forEach(function (t) { allTypes[t] = true; }); });
  var byId = {}; drivers.forEach(function (d) { byId[d.id] = d; });
  var pending = [];
  var take = function (s, id, flags) { out[s.id] = { driverId: id, flags: flags }; load[id]++; members[id].push(s); };

  stops.forEach(function (s) {
    if (!isFinite(s.lat) || !isFinite(s.lng) || s.lat === null) { out[s.id] = { driverId: s.driverId && byId[s.driverId] ? s.driverId : null, flags: ['notFound'] }; return; }
    if (s.driverId && byId[s.driverId]) { take(s, s.driverId, ['manual']); return; }
    var need = (s.tags || []).filter(function (t) { return allTypes[t]; });
    var flags = [];
    var fit = drivers.filter(function (d) { return need.every(function (t) { return (d.types || []).indexOf(t) >= 0; }); });
    if (!fit.length) { flags.push('type'); fit = drivers; }
    var inArea = fit.filter(function (d) { return (d.areas || []).some(function (r) { return phloInArea(s, r); }); });
    if (inArea.length === 1) { take(s, inArea[0].id, flags); return; }
    pending.push({ s: s, flags: flags.concat(inArea.length ? ['overlap'] : ['outside']), cands: inArea.length ? inArea : fit });
  });
  if (!drivers.length) { pending.forEach(function (p) { out[p.s.id] = { driverId: null, flags: p.flags }; }); return out; }

  // Unclear stops go to the candidate with the nearest stop (or start) already, avoiding full drivers.
  var near = function (d, s) {
    var best = d.start ? phloKm(d.start, s) * 1.5 : 1e9;
    members[d.id].forEach(function (m) { best = Math.min(best, phloKm(m, s)); });
    (d.areas || []).forEach(function (r) { r.forEach(function (p) { best = Math.min(best, phloKm({ lat: p[0], lng: p[1] }, s) * 1.2); }); });
    return best;
  };
  pending.forEach(function (p) {
    var best = null, bestScore = Infinity;
    p.cands.forEach(function (d) {
      var full = typeof d.capacity === 'number' && load[d.id] >= d.capacity;
      var score = near(d, p.s) + (full ? 1e6 : 0);
      if (score < bestScore) { bestScore = score; best = d; }
    });
    take(p.s, best.id, p.flags);
  });
  return out;
}

/**
 * Orders stops to keep driving short: nearest-neighbour, then 2-opt and single-stop moves.
 * points: [{lat, lng}], start: {lat, lng} or null, end: {lat, lng} or null. cost(a, b) defaults to phloEstMin.
 * Returns the visiting order as indexes into points.
 */
function phloOrderStops(points, start, end, cost) {
  cost = cost || phloEstMin;
  var n = points.length;
  if (n < 2) return points.map(function (p, i) { return i; });
  var left = points.map(function (p, i) { return i; }), order = [];
  var at = start || points[0];
  if (!start) { order.push(0); left.shift(); }
  while (left.length) {
    var bi = 0, bc = Infinity;
    left.forEach(function (idx, k) { var c = cost(at, points[idx]); if (c < bc) { bc = c; bi = k; } });
    var next = left.splice(bi, 1)[0];
    order.push(next); at = points[next];
  }
  var node = function (k) { return k < 0 ? start : k >= n ? end : points[order[k]]; };
  var edge = function (a, b) { var p = node(a), q = node(b); return p && q ? cost(p, q) : 0; };
  var improved = true, rounds = 0;
  while (improved && rounds++ < 50) {
    improved = false;
    // 2-opt: reverse order[i..k].
    for (var i = start ? 0 : 1; i < n - 1; i++) {
      for (var k = i + 1; k < n; k++) {
        var delta = edge(i - 1, k) + edge(i, k + 1) - edge(i - 1, i) - edge(k, k + 1);
        if (delta < -1e-9) {
          var seg = order.slice(i, k + 1).reverse();
          for (var m = 0; m < seg.length; m++) order[i + m] = seg[m];
          improved = true;
        }
      }
    }
    // Move one stop elsewhere.
    for (var a = start ? 0 : 1; a < n; a++) {
      var removeGain = edge(a - 1, a) + edge(a, a + 1) - edge(a - 1, a + 1);
      var moving = order[a];
      var rest = order.slice(0, a).concat(order.slice(a + 1));
      var bestPos = -1, bestAdd = removeGain - 1e-9;
      var restNode = function (k) { return k < 0 ? start : k >= rest.length ? end : points[rest[k]]; };
      for (var pos = start ? 0 : 1; pos <= rest.length; pos++) {
        var p = restNode(pos - 1), q = restNode(pos), x = points[moving];
        var add = (p ? cost(p, x) : 0) + (q ? cost(x, q) : 0) - (p && q ? cost(p, q) : 0);
        if (add < bestAdd) { bestAdd = add; bestPos = pos; }
      }
      if (bestPos >= 0) { rest.splice(bestPos, 0, moving); order = rest; improved = true; }
    }
  }
  return order;
}

/**
 * Splits an ordered route into pieces Google can optimize (at most `max` stops between fixed ends).
 * Returns [{from: index or -1 for the start, via: [indexes], to: index or 'end'}]. Indexes are positions in the route.
 */
function phloRouteSegments(n, hasEnd, max) {
  max = max || GOOGLE_MAX_VIA;
  var segs = [], i = 0, prev = -1;
  var range = function (a, b) { var r = []; for (var k = a; k < b; k++) r.push(k); return r; };
  if (!n) return hasEnd ? [{ from: -1, via: [], to: 'end' }] : [];
  while (i < n) {
    var remaining = n - i;
    if (hasEnd && remaining <= max) { segs.push({ from: prev, via: range(i, n), to: 'end' }); break; }
    if (!hasEnd && remaining <= max + 1) { segs.push({ from: prev, via: range(i, n - 1), to: n - 1 }); break; }
    segs.push({ from: prev, via: range(i, i + max), to: i + max });
    prev = i + max; i += max + 1;
  }
  if (hasEnd && segs[segs.length - 1].to !== 'end') segs.push({ from: prev, via: [], to: 'end' });
  return segs;
}

/**
 * Arrival times for a route.
 * legs: driving minutes [start->1st, 1st->2nd, ..., last->end (only when there is an end)].
 * driver: {availableFrom, availableTo, lunchFrom, lunchTo, speed}. Leg minutes are scaled by the driver's speed.
 * Returns {etas: ['HH:MM'], start, finish, driveMin, late: [indexes of stops reached after availableTo], lunchBefore: index or -1}.
 */
function phloSchedule(legs, nStops, driver, opts) {
  opts = opts || {};
  var service = opts.serviceMin == null ? DISPATCH_DEFAULTS.serviceMin : opts.serviceMin;
  var factor = SPEED_FACTORS[driver.speed] || 1;
  var t = phloToMin(driver.availableFrom || opts.dayStart || DISPATCH_DEFAULTS.dayStart);
  var startT = t;
  var lunch = driver.lunchFrom && driver.lunchTo ? [phloToMin(driver.lunchFrom), phloToMin(driver.lunchTo)] : null;
  var lunchBefore = -1, drive = 0, etas = [], late = [];
  var until = driver.availableTo ? phloToMin(driver.availableTo) : null;
  for (var i = 0; i <= nStops; i++) {
    if (i === nStops && legs.length <= nStops) break;
    var leg = (legs[i] || 0) * factor;
    // Lunch goes between stops, right before the drive that would run into lunch time (no more than 30 min early).
    if (lunch && lunchBefore < 0 && t + leg > lunch[0]) { t = Math.max(t, lunch[0] - 30) + (lunch[1] - lunch[0]); lunchBefore = i; }
    t += leg; drive += leg;
    if (i === nStops) break;
    etas.push(phloFromMin(t));
    if (until !== null && t > until) late.push(i);
    t += service;
  }
  return { etas: etas, start: phloFromMin(startT), finish: phloFromMin(t), driveMin: Math.round(drive), late: late, lunchBefore: lunchBefore };
}

/** Decodes a Google encoded polyline into [{lat, lng}]. */
function phloDecodePolyline(str) {
  var out = [], i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (var c = 0; c < 2; c++) {
      var shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 31) << shift; shift += 5; } while (b >= 32);
      var d = result & 1 ? ~(result >> 1) : result >> 1;
      if (c === 0) lat += d; else lng += d;
    }
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

/** Google Maps directions link to a stop (opens the Maps app on a phone). */
function phloNavUrl(stop) {
  return 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' +
    (isFinite(stop.lat) && stop.lat !== null ? stop.lat + ',' + stop.lng : encodeURIComponent(stop.address));
}

/** Delivery outcome choices a driver can tick. */
var DELIVERY_METHODS = [
  { value: 'mailbox', label: 'Left in mailbox' },
  { value: 'door', label: 'Left at front door' },
  { value: 'approved', label: 'Approved by pharmacy staff' }
];

/** Problems with a driver's stop update: [message]. Approved needs the staff name; not delivered needs a reason. */
function phloCheckUpdate(u) {
  var errs = [];
  if (u.status !== 'delivered' && u.status !== 'failed') errs.push('Pick Delivered or Not delivered.');
  if ((u.methods || []).indexOf('approved') >= 0 && !phloCleanText(u.approvedBy)) errs.push('Type the name of the pharmacy staff who approved it.');
  if (u.status === 'failed' && !phloCleanText(u.note)) errs.push('Say why it was not delivered.');
  if (u.copayCollected && !/^\$?\d+(\.\d{1,2})?$/.test(String(u.copayCollected).trim())) errs.push('Copay collected should be an amount like 5.00.');
  return errs;
}
