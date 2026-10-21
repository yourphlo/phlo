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

var AREA_BUFFER_KM = 3.22; // a driver can take stops up to 2 miles outside their drawn area

/** Distance in km from a point to a drawn area (0 inside it). */
function phloAreaKm(p, ring) {
  if (phloInArea(p, ring)) return 0;
  var kx = 111.32 * Math.cos(p.lat * Math.PI / 180), ky = 110.57, best = Infinity;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    var ax = (ring[j][1] - p.lng) * kx, ay = (ring[j][0] - p.lat) * ky;
    var bx = (ring[i][1] - p.lng) * kx, by = (ring[i][0] - p.lat) * ky;
    var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    var t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    var x = ax + t * dx, y = ay + t * dy;
    best = Math.min(best, Math.sqrt(x * x + y * y));
  }
  return best;
}

/** Distance in km from a point to the nearest of a driver's areas; null when they have none. */
function phloDriverAreaKm(p, d) {
  if (!d.areas || !d.areas.length) return null;
  return Math.min.apply(null, d.areas.map(function (r) { return phloAreaKm(p, r); }));
}

/**
 * Picks a driver for every stop, keeping each driver near their own area and routes from overlapping.
 * stops: [{id, lat, lng, tags, driverId, fixed}] (lat/lng missing = address not found). driverId with
 *   fixed: true keeps the stop with that driver but doesn't flag it as moved by hand (used when re-checking
 *   one stop against routes already planned); driverId alone = picked by hand.
 * drivers: [{id, areas, types, capacity, start: {lat, lng}, end: {lat, lng}}] (the drivers working that day)
 * Rules:
 *   - A tag that is also some driver's type (e.g. FRIDGE) means only drivers with that type can take it.
 *   - A stop can go to drivers whose area is within 2 miles of it. Drivers with no area drawn only take
 *     stops that no area reaches. A stop that no area reaches can go to anyone (flag: outside).
 *   - Each stop starts with the nearest area, then stops move one at a time to whichever allowed driver's
 *     route passes closest (cheapest detour), until no move shortens the total driving. That pulls stray
 *     stops onto the route that already goes by them and keeps routes from crossing into each other.
 *   - capacity is a hard limit (stops picked by hand aside): a stop that no allowed driver has room for
 *     is left off the routes (driverId null, flag: full), after trying to make room by moving one of a
 *     full driver's stops to a neighbour with room.
 * Returns {stopId: {driverId, flags: [...]}}. Flags: notFound, outside, overlap (several areas reach it),
 * type (no working driver has its types), full, manual (picked by hand).
 */
function phloAssignStops(stops, drivers, cost) {
  cost = cost || phloEstMin;
  var out = {}, byId = {}, allTypes = {}, anyAreas = false;
  drivers.forEach(function (d) {
    byId[d.id] = d;
    (d.types || []).forEach(function (t) { allTypes[t] = true; });
    if (d.areas && d.areas.length) anyAreas = true;
  });
  var routes = {}, load = {};
  drivers.forEach(function (d) { routes[d.id] = []; load[d.id] = 0; });
  var cap = function (d) { return typeof d.capacity === 'number' ? d.capacity : Infinity; };
  var movable = [];

  stops.forEach(function (s) {
    if (!isFinite(s.lat) || !isFinite(s.lng) || s.lat === null) {
      out[s.id] = { driverId: s.driverId && byId[s.driverId] ? s.driverId : null, flags: ['notFound'] };
      return;
    }
    if (s.driverId && byId[s.driverId]) {
      out[s.id] = { driverId: s.driverId, flags: s.fixed ? [] : ['manual'] };
      routes[s.driverId].push(s); load[s.driverId]++;
      return;
    }
    var flags = [];
    var need = (s.tags || []).filter(function (t) { return allTypes[t]; });
    var fit = drivers.filter(function (d) { return need.every(function (t) { return (d.types || []).indexOf(t) >= 0; }); });
    if (!fit.length) { flags.push('type'); fit = drivers.slice(); }
    var km = {};
    fit.forEach(function (d) { km[d.id] = phloDriverAreaKm(s, d); });
    var near = fit.filter(function (d) { return km[d.id] !== null && km[d.id] <= AREA_BUFFER_KM; });
    var cands = near;
    if (!near.length) {
      var noArea = fit.filter(function (d) { return km[d.id] === null; });
      cands = noArea.length ? noArea : fit;
      if (anyAreas) flags.push('outside');
    } else if (near.filter(function (d) { return km[d.id] === 0; }).length !== 1) {
      flags.push('overlap');
    }
    movable.push({ s: s, flags: flags, cands: cands, km: km });
  });
  if (!drivers.length) {
    movable.forEach(function (m) { out[m.s.id] = { driverId: null, flags: m.flags }; });
    return out;
  }

  // 1. Start each stop with the nearest area (else the nearest start) that has room. Stops with the
  //    fewest choices go first so they get a place before the flexible ones fill the drivers up.
  var score0 = function (m, d) { return (m.km[d.id] !== null ? m.km[d.id] : 0) * 10 + (d.start ? phloKm(d.start, m.s) : 0); };
  movable.slice().sort(function (a, b) { return a.cands.length - b.cands.length; }).forEach(function (m) {
    var best = null, bestScore = Infinity;
    m.cands.forEach(function (d) {
      if (load[d.id] >= cap(d)) return;
      var score = score0(m, d);
      if (score < bestScore) { bestScore = score; best = d; }
    });
    m.driverId = best ? best.id : null;
    if (best) { load[best.id]++; routes[best.id].push(m.s); }
  });

  // 2. Order each route, then move stops to whichever allowed route passes closest.
  drivers.forEach(function (d) {
    var r = routes[d.id];
    routes[d.id] = phloOrderStops(r, d.start || null, d.end || null, cost).map(function (i) { return r[i]; });
  });
  var leg = function (a, b) { return a && b ? cost(a, b) : 0; };
  // A small preference for staying inside one's own drawn area (minutes).
  var outsidePenalty = function (m, d) { return m.km[d.id] ? 2 : 0; };
  var removeSaving = function (d, i) {
    var r = routes[d.id], prev = i > 0 ? r[i - 1] : d.start, next = i < r.length - 1 ? r[i + 1] : d.end;
    return leg(prev, r[i]) + leg(r[i], next) - leg(prev, next);
  };
  var bestInsert = function (d, s) {
    var r = routes[d.id], best = { cost: Infinity, pos: 0 };
    for (var p = 0; p <= r.length; p++) {
      var prev = p > 0 ? r[p - 1] : d.start, next = p < r.length ? r[p] : d.end;
      var c = !prev && !next ? 0 : leg(prev, s) + leg(s, next) - leg(prev, next);
      if (c < best.cost) best = { cost: c, pos: p };
    }
    return best;
  };
  var place = function (m, d, pos) { routes[d.id].splice(pos, 0, m.s); load[d.id]++; m.driverId = d.id; };
  var take = function (m) { var r = routes[m.driverId], i = r.indexOf(m.s); r.splice(i, 1); load[m.driverId]--; m.driverId = null; };
  var byStop = {}; movable.forEach(function (m) { byStop[m.s.id] = m; });
  // A stop no allowed driver has room for: put it with one that has room, else make room by moving one
  // of a full driver's stops to a neighbour with room (cheapest way). Returns true when placed.
  var fit = function (m) {
    var best = null, bestCost = Infinity;
    m.cands.forEach(function (d) {
      if (load[d.id] >= cap(d)) return;
      var ins = bestInsert(d, m.s), c = ins.cost + outsidePenalty(m, d);
      if (c < bestCost) { bestCost = c; best = { d: d, pos: ins.pos }; }
    });
    if (best) { place(m, best.d, best.pos); return true; }
    var swap = null;
    m.cands.forEach(function (d) {
      var add = bestInsert(d, m.s).cost + outsidePenalty(m, d);
      routes[d.id].forEach(function (s2, i) {
        var m2 = byStop[s2.id];
        if (!m2) return; // picked by hand: stays
        var out2 = removeSaving(d, i);
        m2.cands.forEach(function (e) {
          if (e.id === d.id || load[e.id] >= cap(e)) return;
          var c = add - out2 + bestInsert(e, s2).cost + outsidePenalty(m2, e);
          if (!swap || c < swap.c) swap = { c: c, d: d, m2: m2, e: e };
        });
      });
    });
    if (!swap) return false;
    take(swap.m2); place(swap.m2, swap.e, bestInsert(swap.e, swap.m2.s).pos);
    place(m, swap.d, bestInsert(swap.d, m.s).pos);
    return true;
  };
  for (var pass = 0; pass < 20; pass++) {
    var moved = false;
    movable.forEach(function (m) {
      if (!m.driverId) { if (fit(m)) moved = true; return; }
      if (m.cands.length < 2) return;
      var from = byId[m.driverId], idx = routes[from.id].indexOf(m.s);
      var stay = removeSaving(from, idx) + outsidePenalty(m, from);
      var best = null, bestCost = stay - 0.5; // move only for a real gain (half a minute)
      m.cands.forEach(function (d) {
        if (d.id === from.id || load[d.id] >= cap(d)) return;
        var ins = bestInsert(d, m.s);
        var c = ins.cost + outsidePenalty(m, d);
        if (c < bestCost) { bestCost = c; best = { d: d, pos: ins.pos }; }
      });
      if (!best) return;
      routes[from.id].splice(idx, 1); load[from.id]--;
      routes[best.d.id].splice(best.pos, 0, m.s); load[best.d.id]++;
      m.driverId = best.d.id;
      moved = true;
    });
    if (!moved) break;
  }
  movable.forEach(function (m) { out[m.s.id] = { driverId: m.driverId, flags: m.driverId ? m.flags : m.flags.concat(['full']) }; });
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
