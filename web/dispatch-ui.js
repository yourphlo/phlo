/* PHLO Dispatch tab: turns the built master into one route per working driver.
 *   1. Finds every address on Google Maps (and each driver's start/end if not pinned).
 *   2. Gives each stop to a driver by coverage area; unclear stops are flagged for a look.
 *   3. Orders each route (our own planner, then Google's road-time optimizer) and times it.
 *   4. Map + route lists to check and move stops, printable route sheets, "Send to drivers",
 *      and a live view of what drivers record at each stop.
 * Uses window.PHLO (app.js), phloMaps (maps.js), phloBackend (backend.js) and dispatch.js. */
(function () {
  'use strict';

  var CFG = window.PHLO_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var A, el, toast; // set on DOMContentLoaded (app.js runs first)

  var geoCache = {};       // address -> {lat, lng, partial, formatted} | {none: true}, for this page visit only
  var plan = null;         // {iso, stops, drivers, routes, warnings}
  var dmap = { map: null, loading: null, markers: [], lines: [], areas: [], info: null, ov: null, tool: 'move', sel: {}, lasso: null };
  var live = { timer: null, busy: false };

  // Check before sending lists address problems only; who takes which stop is checked by hand.
  var FLAG_TEXT = {
    notFound: 'Address not found on Google Maps',
    partial: 'Google only found part of this address, so the route uses the address it found'
  };
  function addressFlags(flags) { return flags.filter(function (f) { return FLAG_TEXT[f]; }); }

  /** The address the route uses: what Google found, else what was typed. */
  function useAddr(s) { return s.formatted || s.address; }

  /** "Pharmacy wrote: ..." when the route uses a different address than the pharmacy typed (Google only found
   * part of it, or it was retyped here), so the driver and office can still see the original. */
  function typedNote(s) { return s.typed && (s.partial || s.address !== s.typed) ? 'Pharmacy wrote: ' + s.typed : ''; }

  /** An address cell: the address used, with the pharmacy's original underneath when it differs. */
  function addrCell(s) {
    var t = typedNote(s);
    return el('td', {}, [useAddr(s), t ? el('br') : null, t ? el('span', { class: 'typed', text: t }) : null]);
  }

  /* ---------------- setup + summary ---------------- */

  function working(iso) {
    var ids = A.rosterFor(iso);
    return A.drivers().filter(function (d) { return ids.indexOf(d.id) >= 0; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function renderSummary() {
    var iso = A.deliveryIso();
    var rows = A.rows();
    var ws = working(iso);
    $('dp-date').textContent = iso ? 'Deliveries for ' + A.niceDate(A.fromIso(iso)) : '';
    $('dp-summary').textContent = (A.built() ? rows.length + ' stops from the master' : 'Build the master first (Master tab)') +
      ' · ' + ws.length + ' driver' + (ws.length === 1 ? '' : 's') + ' working' + (ws.length ? ' (' + ws.map(function (d) { return d.name.split(' ')[0]; }).join(', ') + ')' : '');
    $('dp-plan').disabled = !A.built() || !rows.length || !ws.length;
    $('dp-send').title = phloBackend.enabled ? '' : 'Set up the dispatch server first (README: Driver app)';
    $('dp-live-card').hidden = !phloBackend.enabled;
    if (!$('dp-live-date').value) $('dp-live-date').value = iso || A.isoDate(A.todayLocal());
  }

  function note(msg) { $('dp-note').textContent = msg || ''; }

  /** The most stops a driver gets: the Max stops box, or the driver's own capacity if that is lower. */
  function maxStops(d) {
    var box = parseInt($('dp-max').value, 10);
    var max = box > 0 ? box : Infinity;
    return typeof d.src.capacity === 'number' ? Math.min(d.src.capacity, max) : max;
  }
  function driverInput(d) {
    var m = maxStops(d);
    return { id: d.id, areas: d.src.areas, types: d.src.types, capacity: isFinite(m) ? m : '', start: d.startPt, end: d.endPt };
  }

  /* ---------------- Google: addresses ---------------- */

  function geocoder() {
    return phloMaps.library('geocoding').then(function (lib) { return new lib.Geocoder(); });
  }

  function geocode(g, address) {
    if (geoCache[address]) return Promise.resolve(geoCache[address]);
    return g.geocode({ address: address, componentRestrictions: { country: CFG.mapsRegion || 'us' } }).then(function (r) {
      var best = r.results && r.results[0];
      var q = best ? phloGeocodeQuality(best.types, best.partial_match) : 'none';
      geoCache[address] = q !== 'none' ? { lat: best.geometry.location.lat(), lng: best.geometry.location.lng(), partial: q === 'partial', formatted: best.formatted_address } : { none: true };
      return geoCache[address];
    }, function (e) {
      if (/ZERO_RESULTS/.test(e && (e.code || e.message))) { geoCache[address] = { none: true }; return geoCache[address]; }
      throw e;
    });
  }

  /** Runs fn over items, a few at a time. */
  function pool(items, size, fn, progress) {
    var i = 0, done = 0;
    return new Promise(function (resolve, reject) {
      if (!items.length) { resolve(); return; }
      var next = function () {
        if (i >= items.length) return;
        var item = items[i++];
        fn(item).then(function () {
          done++; if (progress) progress(done, items.length);
          if (done === items.length) resolve(); else next();
        }, reject);
      };
      for (var k = 0; k < Math.min(size, items.length); k++) next();
    });
  }

  /* ---------------- Google: road times ---------------- */

  function point(p) { return { location: { latLng: { latitude: p.lat, longitude: p.lng } } }; }
  function seconds(d) { return parseFloat(String(d || '0').replace('s', '')) || 0; }

  function computeRoute(from, via, to) {
    var body = { origin: point(from), destination: point(to), intermediates: via.map(point), travelMode: 'DRIVE' };
    if (via.length > 1) body.optimizeWaypointOrder = true;
    return fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-Goog-Api-Key': CFG.mapsApiKey,
        'X-Goog-FieldMask': 'routes.legs.duration,routes.legs.distanceMeters,routes.optimizedIntermediateWaypointIndex,routes.polyline.encodedPolyline'
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (j) {
        if (!res.ok || !j.routes || !j.routes[0]) throw new Error((j.error && j.error.message) || 'no route found');
        return j.routes[0];
      });
    });
  }

  /** Orders and times one driver's stops. Uses Google road times when it can, else estimates. */
  function routeDriver(d) {
    var r = plan.routes[d.id];
    var stops = plan.stops.filter(function (s) { return s.driverId === d.id && s.lat != null; });
    var start = d.startPt, end = d.endPt;
    var order = phloOrderStops(stops, start, end).map(function (i) { return stops[i]; });
    r.estimated = true; r.polyline = null; r.km = null; r.googleError = '';
    var estLegs = function (list) {
      var legs = [], at = start;
      list.forEach(function (s) { legs.push(at ? phloEstMin(at, s) : 0); at = s; });
      if (end && list.length) legs.push(phloEstMin(at, end));
      return legs;
    };
    var finish = function (list, legs) {
      r.stopIds = list.map(function (s) { return s.id; });
      r.legs = legs;
      r.schedule = phloSchedule(legs, list.length, d.src, { dayStart: $('dp-start').value || '09:00', serviceMin: +$('dp-service').value || 0 });
      list.forEach(function (s, i) { s.seq = i + 1; s.eta = r.schedule.etas[i]; s.late = r.schedule.late.indexOf(i) >= 0; });
    };
    finish(order, estLegs(order));
    if (!order.length || !start || !CFG.mapsApiKey) return Promise.resolve();

    var segs = phloRouteSegments(order.length, !!end);
    var node = function (k) { return k === -1 ? start : k === 'end' ? end : order[k]; };
    return Promise.all(segs.map(function (seg) {
      return computeRoute(node(seg.from), seg.via.map(node), node(seg.to));
    })).then(function (results) {
      var list = [], legs = [], line = [], km = 0;
      results.forEach(function (route, k) {
        var seg = segs[k];
        var via = seg.via.slice();
        if (route.optimizedIntermediateWaypointIndex && route.optimizedIntermediateWaypointIndex.length === via.length && via.length > 1) {
          via = route.optimizedIntermediateWaypointIndex.map(function (i) { return seg.via[i]; });
        }
        via.forEach(function (i) { list.push(order[i]); });
        if (seg.to !== 'end') list.push(order[seg.to]);
        (route.legs || []).forEach(function (leg) { legs.push(seconds(leg.duration) / 60); km += (leg.distanceMeters || 0) / 1000; });
        if (route.polyline && route.polyline.encodedPolyline) line = line.concat(phloDecodePolyline(route.polyline.encodedPolyline));
      });
      if (list.length !== order.length) throw new Error('route pieces did not add up');
      finish(list, legs);
      r.estimated = false; r.polyline = line; r.km = km;
    }).catch(function (e) {
      r.googleError = e.message;
    });
  }

  /* ---------------- plan ---------------- */

  function planRoutes() {
    var iso = A.deliveryIso();
    var ws = working(iso);
    var rows = A.rows();
    if (!rows.length || !ws.length) return;
    if (!phloMaps.enabled) { toast('Planning needs the Google Maps key (mapsApiKey in config.js).'); return; }
    $('dp-plan').disabled = true;
    $('dp-send').disabled = $('dp-print').disabled = true;
    var keepManual = {};
    if (plan && plan.iso === iso) plan.stops.forEach(function (s) { if (s.manual) keepManual[s.id] = s.driverId; });

    var stops = rows.map(function (row, i) {
      var info = phloStopInfo(row);
      return { id: phloStopId(row), row: i, name: String(row[0] || ''), address: String(row[1] || ''), typed: String(row[1] || ''), store: info.store,
        notes: String(row[3] || ''), copay: info.copay, tags: info.tags, lat: null, lng: null, flags: [] };
    });
    // Two rows with the same RX numbers would share an id: keep ids unique.
    var seen = {};
    stops.forEach(function (s) { if (seen[s.id]) s.id += '-' + s.row; seen[s.id] = true; });
    var drivers = ws.map(function (d) { return { src: d, id: d.id, name: d.name }; });
    plan = { iso: iso, stops: stops, drivers: drivers, routes: {}, problems: [] };
    drivers.forEach(function (d) { plan.routes[d.id] = { stopIds: [] }; });

    note('Finding addresses on Google Maps…');
    geocoder().then(function (g) {
      // Driver start/end points: their pins, else look the address up.
      var lookups = [];
      drivers.forEach(function (d) {
        var src = d.src;
        d.startPt = src.startPin ? { lat: src.startPin.lat, lng: src.startPin.lng } : null;
        d.endPt = src.endPin ? { lat: src.endPin.lat, lng: src.endPin.lng } : null;
        if (!d.startPt && src.startAddress) lookups.push(function () { return geocode(g, src.startAddress).then(function (r) { if (!r.none) d.startPt = { lat: r.lat, lng: r.lng }; else plan.problems.push(d.name + '\'s start address was not found on Google Maps, so the route starts at the first stop. Fix it on the Drivers tab.'); }); });
        if (!d.endPt && src.endAddress) lookups.push(function () { return geocode(g, src.endAddress).then(function (r) { if (!r.none) d.endPt = { lat: r.lat, lng: r.lng }; else plan.problems.push(d.name + '\'s end address was not found on Google Maps, so the route ends at the last stop. Fix it on the Drivers tab.'); }); });
      });
      stops.forEach(function (s) {
        lookups.push(function () {
          if (!s.address) { s.flags.push('notFound'); return Promise.resolve(); }
          return geocode(g, s.address).then(function (r) {
            if (r.none) return;
            s.lat = r.lat; s.lng = r.lng; s.formatted = r.formatted;
            if (r.partial) s.partial = true;
          });
        });
      });
      return pool(lookups, 5, function (f) { return f(); }, function (n, total) { note('Finding addresses on Google Maps… ' + n + ' of ' + total); });
    }).then(function () {
      assign(keepManual);
      note('Planning routes…');
      return Promise.all(drivers.map(function (d) { return routeDriver(d); }));
    }).then(function () {
      afterPlan();
    }).catch(function (e) {
      note('Could not plan routes: ' + (e && e.message || e));
    }).then(function () {
      $('dp-plan').disabled = false;
    });
  }

  function assign(manual) {
    var input = plan.stops.map(function (s) {
      return { id: s.id, lat: s.lat, lng: s.lng, tags: s.tags, driverId: manual && manual[s.id] };
    });
    var ds = plan.drivers.map(function (d) {
      return driverInput(d);
    });
    var res = phloAssignStops(input, ds);
    plan.stops.forEach(function (s) {
      var r = res[s.id];
      s.driverId = r.driverId;
      s.manual = r.flags.indexOf('manual') >= 0;
      s.flags = addressFlags(r.flags);
      s.full = r.flags.indexOf('full') >= 0;
      if (s.partial && s.flags.indexOf('notFound') < 0) s.flags.push('partial');
    });
  }

  function afterPlan() {
    var gErr = plan.drivers.map(function (d) { return plan.routes[d.id].googleError; }).filter(Boolean);
    note(gErr.length ? 'Google road times were not available (' + gErr[0] + '), so times are estimates. Plan again to retry.' : '');
    $('dp-print').disabled = false;
    $('dp-send').disabled = !phloBackend.enabled;
    renderFlags();
    renderRoutes();
    renderMap();
  }

  /** Moves a stop to another driver (or back to "nobody") and re-plans the routes it left and joined. */
  function moveStop(stop, driverId) { moveStops([stop], driverId); }

  /** Moves several stops to one driver ('' = off the routes) and re-plans every route that changed. */
  function moveStops(stops, driverId) {
    driverId = driverId || null;
    var changed = {}, moved = 0;
    stops.forEach(function (stop) {
      if (stop.lat == null || stop.driverId === driverId) return;
      if (stop.driverId) changed[stop.driverId] = true;
      stop.driverId = driverId;
      stop.manual = !!driverId;
      stop.full = false;
      stop.flags = addressFlags(stop.flags);
      moved++;
    });
    if (!moved) { toast(driverId ? 'Those stops are already with ' + driverName(driverId) + '.' : 'Those stops are already off the routes.'); return Promise.resolve(); }
    if (driverId) changed[driverId] = true;
    var touched = plan.drivers.filter(function (d) { return changed[d.id]; });
    note('Re-planning…');
    return Promise.all(touched.map(routeDriver)).then(function () {
      afterPlan();
      var what = moved === 1 ? '' : moved + ' stops ';
      toast(driverId ? 'Moved ' + what + 'to ' + driverName(driverId) : 'Took ' + what + 'off the routes');
    });
  }

  /** A not-found address typed again from the flags list. */
  function retryAddress(stop, address) {
    stop.address = address;
    stop.partial = false;
    geocoder().then(function (g) { return geocode(g, address); }).then(function (r) {
      if (r.none) { toast('Google Maps still cannot find that address.'); return; }
      stop.lat = r.lat; stop.lng = r.lng; stop.formatted = r.formatted; stop.partial = r.partial;
      // Check the fixed stop against the routes already planned (they stay as they are).
      var others = plan.stops.filter(function (x) { return x !== stop && x.driverId && x.lat != null; })
        .map(function (x) { return { id: x.id, lat: x.lat, lng: x.lng, driverId: x.driverId, fixed: true }; });
      var res = phloAssignStops(others.concat([{ id: stop.id, lat: r.lat, lng: r.lng, tags: stop.tags, driverId: stop.manual ? stop.driverId : null }]),
        plan.drivers.map(driverInput))[stop.id];
      stop.driverId = res.driverId;
      stop.flags = addressFlags(res.flags);
      stop.full = res.flags.indexOf('full') >= 0;
      if (r.partial) stop.flags.push('partial');
      var d = plan.drivers.filter(function (x) { return x.id === stop.driverId; })[0];
      return (d ? routeDriver(d) : Promise.resolve()).then(afterPlan);
    }).catch(function (e) { toast('Could not look up the address: ' + e.message); });
  }

  /* ---------------- flags, routes ---------------- */

  function driverName(id) {
    var d = plan.drivers.filter(function (x) { return x.id === id; })[0];
    return d ? d.name : 'nobody';
  }

  function moveSelect(stop) {
    var sel = el('select', { 'aria-label': 'Driver for ' + stop.name });
    sel.appendChild(el('option', { value: '', text: stop.lat == null ? '(not on a route)' : '(nobody)' }));
    plan.drivers.forEach(function (d) {
      var o = el('option', { value: d.id, text: d.name });
      if (d.id === stop.driverId) o.selected = true;
      sel.appendChild(o);
    });
    sel.disabled = stop.lat == null;
    sel.addEventListener('change', function () { moveStop(stop, sel.value); });
    return sel;
  }

  function renderFlags() {
    var list = $('dp-flags');
    list.textContent = '';
    var items = [];
    plan.problems.forEach(function (p) { items.push({ level: 'error', text: p }); });
    plan.stops.forEach(function (s) {
      s.flags.forEach(function (f) {
        var extra = f === 'partial' ? ': ' + (s.formatted || '?') + '. ' + typedNote(s) + '.' : '';
        items.push({ level: f === 'notFound' ? 'error' : 'info', stop: s, flag: f, text: FLAG_TEXT[f] + extra });
      });
    });
    items.forEach(function (it) {
      var li = el('li', { class: it.level + ' wrap' }, [
        el('span', { class: 'where', text: it.stop ? it.stop.name : '' }),
        el('span', { text: it.text })
      ]);
      if (it.stop) {
        var input = el('input', { value: it.stop.address, 'aria-label': 'Address for ' + it.stop.name });
        var btn = el('button', { class: 'btn', type: 'button', text: 'Find' });
        btn.addEventListener('click', function (e) { e.stopPropagation(); retryAddress(it.stop, input.value.trim()); });
        input.addEventListener('click', function (e) { e.stopPropagation(); });
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); retryAddress(it.stop, input.value.trim()); } });
        li.appendChild(el('div', { class: 'dp-fix' }, [input, btn]));
        if (it.stop.lat != null) {
          li.tabIndex = 0;
          li.addEventListener('click', function () { focusStop(it.stop); });
          li.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target === li) focusStop(it.stop); });
        }
      }
      list.appendChild(li);
    });
    if (!items.length) list.appendChild(el('li', { class: 'empty', text: 'Every address was found on Google Maps.' }));
    $('dp-flags-count').textContent = items.length ? String(items.length) : '';
    $('dp-flags-card').hidden = false;
  }

  function fmtMin(m) { m = Math.round(m); return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm'; }

  function renderRoutes() {
    var box = $('dp-routes');
    var open = {};
    box.querySelectorAll('details[open]').forEach(function (d) { open[d.getAttribute('data-id')] = true; });
    box.textContent = '';
    var colors = A.colors();
    var byId = {}; plan.stops.forEach(function (s) { byId[s.id] = s; });
    var total = 0;
    plan.drivers.forEach(function (d) {
      var r = plan.routes[d.id], list = r.stopIds.map(function (id) { return byId[id]; });
      total += list.length;
      var sch = r.schedule;
      var dot = el('span', { class: 'dot' }); dot.style.background = colors[d.id];
      var sum = list.length + ' stop' + (list.length === 1 ? '' : 's') +
        (sch && list.length ? ' · ' + phloClock(sch.start) + '–' + phloClock(sch.finish) + ' · driving ' + fmtMin(sch.driveMin) + (r.km ? ' (' + Math.round(r.km * 0.621) + ' mi)' : '') : '') +
        (r.estimated && list.length ? ' · estimated' : '');
      var warn = [];
      if (list.length > maxStops(d)) warn.push('over the max of ' + maxStops(d));
      if (sch && sch.late.length) warn.push(sch.late.length + ' late');
      var det = el('details', { class: 'dp-route', 'data-id': d.id }, [
        el('summary', {}, [dot, el('b', { text: d.name }), el('span', { class: 'sum', text: sum }), warn.length ? el('span', { class: 'warn-txt', text: warn.join(' · ') }) : null])
      ]);
      if (open[d.id]) det.open = true;
      var tb = el('tbody');
      list.forEach(function (s, i) {
        var lunch = sch && sch.lunchBefore === i;
        if (lunch) tb.appendChild(el('tr', {}, [el('td', { class: 'num', text: '' }), el('td', { class: 'eta muted', text: 'Lunch' }), el('td', { colspan: '4', class: 'muted', text: phloClock(d.src.lunchFrom) + '–' + phloClock(d.src.lunchTo) + ' break' })]));
        tb.appendChild(el('tr', { class: (s.flags.length ? 'flagged ' : '') + (s.late ? 'late' : '') }, [
          el('td', { class: 'num', text: String(i + 1) }),
          el('td', { class: 'eta', text: phloClock(s.eta) }),
          el('td', { class: 'code', text: s.name }),
          addrCell(s),
          el('td', { text: [s.store, s.notes].filter(Boolean).join(' · ') }),
          el('td', {}, [moveSelect(s)])
        ]));
      });
      if (!list.length) tb.appendChild(el('tr', {}, [el('td', { colspan: '6', class: 'muted', text: 'No stops.' })]));
      det.appendChild(el('div', { class: 'table-wrap' }, [el('table', {}, [
        el('thead', {}, [el('tr', {}, ['#', 'ETA', 'NAME', 'ADDRESS', 'NOTES', 'DRIVER'].map(function (h) { return el('th', { text: h }); }))]), tb
      ])]));
      box.appendChild(det);
    });
    var off = plan.stops.filter(function (s) { return !s.driverId; });
    if (off.length) {
      var det = el('details', { class: 'dp-route', 'data-id': '_none', open: '' }, [el('summary', {}, [el('b', { text: 'Not on a route' }), el('span', { class: 'warn-txt', text: off.length + ' stop' + (off.length === 1 ? '' : 's') })])]);
      var ul = el('ul', { class: 'live-list' });
      off.forEach(function (s) {
        var why = s.lat == null ? 'address not found' : s.full ? 'every driver near it has the max stops' : 'taken off by hand';
        ul.appendChild(el('li', {}, [el('span', { class: 'seq', text: '–' }),
          el('span', { class: 'what' }, [el('b', { text: s.name }), ' ' + useAddr(s) + ' ', el('span', { class: 'chip warn', text: why })]), moveSelect(s)]));
      });
      det.appendChild(el('div', { class: 'table-wrap' }, [ul]));
      box.appendChild(det);
    }
    $('dp-routes-count').textContent = total + ' of ' + plan.stops.length + ' stops on routes';
    $('dp-routes-card').hidden = false;
  }

  /* ---------------- map ---------------- */

  function ensureDispatchMap() {
    if (dmap.map) return Promise.resolve(dmap.map);
    if (dmap.loading) return dmap.loading;
    $('dp-map-card').hidden = false;
    dmap.loading = phloMaps.library('maps').then(function (lib) {
      dmap.map = new lib.Map($('dp-map'), { center: { lat: 34.05, lng: -118.25 }, zoom: 10, clickableIcons: false, mapTypeControl: false, streetViewControl: false });
      dmap.info = new lib.InfoWindow();
      // An empty overlay, only to turn map points into screen pixels for the selection loop.
      dmap.ov = new lib.OverlayView();
      dmap.ov.onAdd = dmap.ov.draw = dmap.ov.onRemove = function () {};
      dmap.ov.setMap(dmap.map);
      return dmap.map;
    });
    return dmap.loading;
  }

  function renderMap() {
    ensureDispatchMap().then(function (map) {
      dmap.markers.concat(dmap.lines, dmap.areas).forEach(function (m) { m.setMap(null); });
      dmap.markers = []; dmap.lines = []; dmap.areas = [];
      var colors = A.colors();
      var bounds = new google.maps.LatLngBounds(), any = false;
      plan.drivers.forEach(function (d) {
        (d.src.areas || []).forEach(function (ring) {
          dmap.areas.push(new google.maps.Polygon({ map: map, paths: ring.map(function (p) { return { lat: p[0], lng: p[1] }; }),
            strokeColor: colors[d.id], strokeOpacity: 0.5, strokeWeight: 1, fillColor: colors[d.id], fillOpacity: 0.06, clickable: false }));
        });
        var r = plan.routes[d.id];
        if (r.polyline && r.polyline.length) {
          dmap.lines.push(new google.maps.Polyline({ map: map, path: r.polyline, strokeColor: colors[d.id], strokeOpacity: 0.85, strokeWeight: 4, clickable: false }));
        }
        if (d.startPt) {
          dmap.markers.push(new google.maps.Marker({ map: map, position: d.startPt, title: d.name + ' starts here', zIndex: 1,
            icon: { path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW, scale: 5, fillColor: colors[d.id], fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 1.5 } }));
          bounds.extend(d.startPt); any = true;
        }
      });
      plan.stops.forEach(function (s) {
        if (s.lat == null) return;
        var m = new google.maps.Marker({
          map: map, position: { lat: s.lat, lng: s.lng }, title: s.name, zIndex: 2,
          label: s.driverId ? { text: String(s.seq || ''), color: '#ffffff', fontSize: '11px', fontWeight: '600' } : null
        });
        m.addListener('click', function () { if (dmap.tool === 'select') toggleSel(s); else openInfo(s, m); });
        s.marker = m;
        styleMarker(s, colors);
        dmap.markers.push(m);
        bounds.extend({ lat: s.lat, lng: s.lng }); any = true;
      });
      if (any && !dmap.fittedFor) { map.fitBounds(bounds, 40); }
      dmap.fittedFor = plan.iso;
      // Keep the selection to stops that are still on the map.
      Object.keys(dmap.sel).forEach(function (id) { if (!plan.stops.some(function (s) { return s.id === id && s.lat != null; })) delete dmap.sel[id]; });
      renderSel();
    }).catch(function (e) { toast('Could not load the map: ' + e.message); });
  }

  /* ---------------- select stops on the map ---------------- */

  /** Selected stops get a black ring and a bigger dot; flagged ones keep a red ring. */
  function styleMarker(s, colors) {
    if (!s.marker) return;
    colors = colors || A.colors();
    var on = !!dmap.sel[s.id];
    s.marker.setIcon({ path: google.maps.SymbolPath.CIRCLE, scale: on ? 13 : 10, fillColor: s.driverId ? colors[s.driverId] : '#777777', fillOpacity: 1,
      strokeColor: on ? '#111111' : s.flags.length ? '#e08a1e' : '#ffffff', strokeWeight: on ? 4 : s.flags.length ? 3 : 1.5 });
    s.marker.setZIndex(on ? 3 : 2);
  }

  function selected() { return plan ? plan.stops.filter(function (s) { return dmap.sel[s.id]; }) : []; }

  function renderSel() {
    var list = selected();
    document.querySelectorAll('[data-dptool]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-dptool') === dmap.tool ? 'true' : 'false'); });
    $('dp-draw').hidden = dmap.tool !== 'select';
    $('dp-sel-help').hidden = dmap.tool !== 'select';
    $('dp-sel').hidden = !list.length;
    if (!list.length) { $('dp-sel-driver').textContent = ''; return; }
    var from = {};
    list.forEach(function (s) { from[s.driverId ? driverName(s.driverId).split(' ')[0] : 'nobody'] = true; });
    $('dp-sel-count').textContent = list.length + ' stop' + (list.length === 1 ? '' : 's') + ' selected (' + Object.keys(from).join(', ') + ')';
    var sel = $('dp-sel-driver'), keep = sel.options.length ? sel.value : null;
    sel.textContent = '';
    plan.drivers.forEach(function (d) { sel.appendChild(el('option', { value: d.id, text: d.name })); });
    sel.appendChild(el('option', { value: '', text: 'Off the routes' }));
    // Keep what was picked; else start on the first driver who doesn't already have these stops.
    var owners = {}; list.forEach(function (s) { owners[s.driverId] = true; });
    var other = plan.drivers.filter(function (d) { return !owners[d.id]; })[0] || plan.drivers[0];
    sel.value = keep !== null && (keep === '' || plan.drivers.some(function (d) { return d.id === keep; })) ? keep : other ? other.id : '';
  }

  function setDpTool(tool) {
    dmap.tool = tool;
    if (tool === 'select' && dmap.info) dmap.info.close();
    renderSel();
  }

  function toggleSel(s) {
    if (s.lat == null) return;
    if (dmap.sel[s.id]) delete dmap.sel[s.id]; else dmap.sel[s.id] = true;
    styleMarker(s);
    renderSel();
  }

  function clearSel() {
    var was = selected();
    dmap.sel = {};
    was.forEach(function (s) { styleMarker(s); });
    renderSel();
  }

  function applySel() {
    var list = selected(), to = $('dp-sel-driver').value;
    if (!list.length) return;
    $('dp-sel-apply').disabled = true;
    dmap.sel = {};
    moveStops(list, to).then(function () { $('dp-sel-apply').disabled = false; renderSel(); });
  }

  function padPt(e) { var r = $('dp-draw').getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  /** Screen pixel of a stop on the map, or null when the map isn't ready. */
  function stopPx(s) {
    var proj = dmap.ov && dmap.ov.getProjection();
    if (!proj) return null;
    var p = proj.fromLatLngToContainerPixel(new google.maps.LatLng(s.lat, s.lng));
    return p ? [p.x, p.y] : null;
  }

  function lassoStart(e) {
    if (!plan || !dmap.map || e.button > 0 || !dmap.ov.getProjection()) return;
    e.preventDefault();
    $('dp-draw').setPointerCapture(e.pointerId);
    var p = padPt(e);
    var line = new google.maps.Polyline({ map: dmap.map, clickable: false, strokeColor: '#111111', strokeOpacity: 0.9, strokeWeight: 2, zIndex: 5 });
    line.getPath().push(dmap.ov.getProjection().fromContainerPixelToLatLng(new google.maps.Point(p[0], p[1])));
    dmap.lasso = { pointer: e.pointerId, pts: [p], line: line };
  }

  function lassoMove(e) {
    var l = dmap.lasso;
    if (!l || e.pointerId !== l.pointer) return;
    var p = padPt(e), last = l.pts[l.pts.length - 1];
    if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 3) return;
    l.pts.push(p);
    l.line.getPath().push(dmap.ov.getProjection().fromContainerPixelToLatLng(new google.maps.Point(p[0], p[1])));
  }

  function lassoEnd(e) {
    var l = dmap.lasso;
    if (!l || e.pointerId !== l.pointer) return;
    dmap.lasso = null;
    l.line.setMap(null);
    if (e.type === 'pointercancel') return;
    var xs = l.pts.map(function (p) { return p[0]; }), ys = l.pts.map(function (p) { return p[1]; });
    var small = Math.max.apply(null, xs) - Math.min.apply(null, xs) < 10 && Math.max.apply(null, ys) - Math.min.apply(null, ys) < 10;
    var onMap = plan.stops.filter(function (s) { return s.lat != null; });
    if (small) {
      // A tap: toggle the nearest stop within reach.
      var best = null, bestD = 18 * 18;
      onMap.forEach(function (s) {
        var q = stopPx(s); if (!q) return;
        var d = (q[0] - l.pts[0][0]) * (q[0] - l.pts[0][0]) + (q[1] - l.pts[0][1]) * (q[1] - l.pts[0][1]);
        if (d < bestD) { bestD = d; best = s; }
      });
      if (best) toggleSel(best);
      return;
    }
    // A loop: add every stop inside it (screen pixels as [y, x] so phloInArea can test them).
    var ring = l.pts.map(function (p) { return [p[1], p[0]]; });
    var added = 0;
    onMap.forEach(function (s) {
      var q = stopPx(s);
      if (q && phloInArea({ lat: q[1], lng: q[0] }, ring) && !dmap.sel[s.id]) { dmap.sel[s.id] = true; styleMarker(s); added++; }
    });
    if (!added) toast('No stops inside that loop.');
    renderSel();
  }

  function lassoWheel(e) {
    if (!dmap.map) return;
    e.preventDefault();
    var now = Date.now();
    if (now - (dmap.wheelAt || 0) < 200) return;
    dmap.wheelAt = now;
    dmap.map.setZoom(dmap.map.getZoom() + (e.deltaY < 0 ? 1 : -1));
  }

  function openInfo(s, marker) {
    var box = el('div', { class: 'info-win' }, [
      el('b', { text: s.name }), el('span', { text: useAddr(s) }),
      typedNote(s) ? el('span', { style: 'color:#6b6862', text: typedNote(s) }) : null,
      s.eta ? el('span', { text: 'Stop ' + s.seq + ' · ETA ' + phloClock(s.eta) }) : null,
      s.notes ? el('span', { text: s.notes }) : null,
      s.flags.length ? el('span', { style: 'color:#8a5a00', text: s.flags.map(function (f) { return FLAG_TEXT[f]; }).join('; ') }) : null,
      el('label', {}, ['Driver ', moveSelect(s)])
    ]);
    dmap.info.setContent(box);
    dmap.info.open({ map: dmap.map, anchor: marker });
  }

  function focusStop(s) {
    if (!s.marker || !dmap.map) return;
    $('dp-map-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    dmap.map.panTo({ lat: s.lat, lng: s.lng });
    if (dmap.map.getZoom() < 14) dmap.map.setZoom(14);
    openInfo(s, s.marker);
  }

  /* ---------------- print ---------------- */

  function printRoutes() {
    var area = $('print-area');
    area.textContent = '';
    var byId = {}; plan.stops.forEach(function (s) { byId[s.id] = s; });
    var day = A.niceDate(A.fromIso(plan.iso));
    plan.drivers.forEach(function (d) {
      var r = plan.routes[d.id];
      if (!r.stopIds.length) return;
      var tb = el('tbody');
      r.stopIds.forEach(function (id, i) {
        var s = byId[id];
        tb.appendChild(el('tr', {}, [
          el('td', { text: String(i + 1) }), el('td', { text: phloClock(s.eta) }),
          el('td', { text: s.name }), addrCell(s), el('td', { text: [s.store, s.notes].filter(Boolean).join(' · ') }),
          el('td', { class: 'box', text: '☐ Delivered  ☐ Not delivered\n☐ Mailbox  ☐ Front door\n☐ Approved by ________\nCopay $______' }),
          el('td', { text: '' })
        ]));
      });
      area.appendChild(el('section', { class: 'print-page' }, [
        el('h1', { text: d.name + ' · ' + day }),
        el('p', { class: 'pmeta', text: r.stopIds.length + ' stops · start ' + phloClock(r.schedule.start) + ' from ' + (d.src.startAddress || '?') +
          ' · finish about ' + phloClock(r.schedule.finish) + (d.src.endAddress ? ' at ' + d.src.endAddress : '') }),
        el('table', {}, [el('thead', {}, [el('tr', {}, ['#', 'ETA', 'Name', 'Address', 'Notes', 'Outcome', 'Signature'].map(function (h) { return el('th', { text: h }); }))]), tb])
      ]));
    });
    area.querySelectorAll('td.box').forEach(function (td) { td.style.whiteSpace = 'pre'; });
    window.print();
  }

  /* ---------------- send to drivers ---------------- */

  function sendRoutes() {
    var token = A.token();
    if (!token) { A.signIn(sendRoutes); return; }
    var flagged = plan.stops.filter(function (s) { return s.flags.indexOf('notFound') >= 0; }).length;
    var off = plan.stops.filter(function (s) { return !s.driverId; }).length;
    var msg = 'Send ' + plan.drivers.filter(function (d) { return plan.routes[d.id].stopIds.length; }).length + ' routes for ' + A.niceDate(A.fromIso(plan.iso)) + ' to the drivers?';
    if (flagged) msg += '\n\n' + flagged + ' stop' + (flagged === 1 ? '\'s address was' : 's\' addresses were') + ' not found on Google Maps (see "Check before sending").';
    if (off) msg += '\n' + off + ' stop' + (off === 1 ? ' is' : 's are') + ' not on any route and will not be sent.';
    msg += '\n\nSending again later replaces these routes; what drivers already recorded is kept.';
    if (!confirm(msg)) return;
    var byId = {}; plan.stops.forEach(function (s) { byId[s.id] = s; });
    var routes = plan.drivers.filter(function (d) { return plan.routes[d.id].stopIds.length; }).map(function (d) {
      var r = plan.routes[d.id];
      return {
        driverId: d.id, driverName: d.name, startAddress: d.src.startAddress, endAddress: d.src.endAddress,
        start: r.schedule.start, finish: r.schedule.finish,
        stops: r.stopIds.map(function (id, i) {
          var s = byId[id];
          // The driver gets the address Google found; the pharmacy's original rides in the notes when it differs.
          return { id: s.id, seq: i + 1, name: s.name, address: useAddr(s), store: s.store, notes: [typedNote(s), s.notes].filter(Boolean).join(' · '),
            copay: s.copay, tags: s.tags, eta: s.eta, lat: s.lat, lng: s.lng };
        })
      };
    });
    $('dp-send').disabled = true;
    note('Sending routes…');
    phloBackend.call('admin.syncDrivers', { googleToken: token, drivers: A.drivers().map(function (d) {
      return { id: d.id, name: d.name, username: phloLoginName(d), salt: d.pinSalt, hash: d.pinHash };
    }) }).then(function () {
      return phloBackend.call('admin.publish', { googleToken: token, date: plan.iso, routes: routes });
    }).then(function () {
      note('');
      var noPin = plan.drivers.filter(function (d) { return plan.routes[d.id].stopIds.length && !d.src.pinHash; }).map(function (d) { return d.name; });
      toast('Sent ' + routes.length + ' routes.' + (noPin.length ? ' No app PIN yet: ' + noPin.join(', ') + ' (Drivers tab).' : ''));
      $('dp-live-date').value = plan.iso;
      refreshLive();
    }).catch(function (e) {
      note('Could not send the routes: ' + e.message);
    }).then(function () { $('dp-send').disabled = false; });
  }

  /* ---------------- live ---------------- */

  var METHOD_TEXT = { mailbox: 'mailbox', door: 'front door', approved: 'approved' };

  function refreshLive() {
    if (!phloBackend.enabled || live.busy) return;
    var token = A.token();
    if (!token) { $('dp-live-note').textContent = 'Sign in with Google to see deliveries.'; return; }
    var iso = $('dp-live-date').value;
    if (!iso) return;
    live.busy = true;
    phloBackend.call('admin.status', { googleToken: token, date: iso }).then(function (r) {
      renderLive(r);
    }).catch(function (e) {
      $('dp-live-note').textContent = 'Could not load deliveries: ' + e.message;
    }).then(function () { live.busy = false; });
  }

  function renderLive(r) {
    var box = $('dp-live');
    box.textContent = '';
    var noteEl = $('dp-live-note');
    if (!r.plan) { noteEl.textContent = 'No routes sent for ' + A.niceDate(A.fromIso(r.date)) + ' yet.'; $('dp-live-count').textContent = ''; return; }
    noteEl.textContent = 'Sent ' + new Date(r.plan.publishedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) +
      ' · updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ' (refreshes every minute)';
    var colors = A.colors(), allDone = 0, allStops = 0;
    r.plan.routes.forEach(function (route) {
      var ok = 0, bad = 0, cash = 0;
      route.stops.forEach(function (s) {
        var u = r.updates[s.id];
        if (u && u.status === 'delivered') ok++; else if (u) bad++;
        if (u && u.copayCollected) cash += parseFloat(String(u.copayCollected).replace('$', '')) || 0;
      });
      allDone += ok + bad; allStops += route.stops.length;
      var n = route.stops.length || 1;
      var bar = el('div', { class: 'bar' }, [el('span', { class: 'ok' }), el('span', { class: 'bad' })]);
      bar.children[0].style.width = (ok / n * 100) + '%';
      bar.children[1].style.width = (bad / n * 100) + '%';
      var dot = el('span', { class: 'dot' }); dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:' + (colors[route.driverId] || '#777');
      var ul = el('ul', { class: 'live-list' });
      route.stops.forEach(function (s) {
        var u = r.updates[s.id];
        var what = el('span', { class: 'what' }, [el('b', { text: s.name }), ' ' + s.address]);
        var right = el('span', {});
        if (u) {
          var bits = [u.status === 'delivered' ? 'Delivered' : 'Not delivered'];
          if (u.methods.length) bits.push(u.methods.map(function (m) { return METHOD_TEXT[m]; }).join(', ') + (u.approvedBy ? ' by ' + u.approvedBy : ''));
          if (u.copayCollected) bits.push('copay ' + (u.copayCollected.charAt(0) === '$' ? '' : '$') + u.copayCollected);
          bits.push(new Date(u.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
          what.appendChild(el('br'));
          what.appendChild(el('span', { class: 'chip ' + (u.status === 'delivered' ? 'ok' : 'bad'), text: bits.join(' · ') }));
          if (u.note) { what.appendChild(el('br')); what.appendChild(document.createTextNode('“' + u.note + '”')); }
          [['photoId', 'Photo'], ['signatureId', 'Signature']].forEach(function (k) {
            if (!u[k[0]]) return;
            var b = el('button', { class: 'linkish', type: 'button', text: k[1] });
            b.addEventListener('click', function () { showFile(u[k[0]], k[1] + ' · ' + s.name); });
            right.appendChild(b);
          });
        } else {
          right.appendChild(el('span', { class: 'muted', text: s.eta ? 'ETA ' + phloClock(s.eta) : '' }));
        }
        ul.appendChild(el('li', {}, [el('span', { class: 'seq', text: String(s.seq) }), what, right]));
      });
      box.appendChild(el('div', { class: 'live-route' }, [
        el('h3', {}, [dot, route.driverName, el('span', { class: 'pill', text: (ok + bad) + ' of ' + route.stops.length + ' done' + (bad ? ' · ' + bad + ' not delivered' : '') }),
          cash ? el('span', { class: 'pill', text: '$' + cash.toFixed(2) + ' collected' }) : null]),
        bar, ul
      ]));
    });
    $('dp-live-count').textContent = allDone + ' of ' + allStops + ' done';
  }

  function showFile(fileId, title) {
    var token = A.token();
    if (!token) { A.signIn(); return; }
    $('img-title').textContent = title;
    $('img-full').removeAttribute('src');
    $('img-dialog').showModal();
    phloBackend.call('admin.file', { googleToken: token, fileId: fileId }).then(function (r) {
      $('img-full').src = r.dataUrl;
    }).catch(function (e) { $('img-dialog').close(); toast('Could not open it: ' + e.message); });
  }

  function startLive() {
    clearInterval(live.timer);
    live.timer = setInterval(function () {
      if (A.view() === 'dispatch' && !document.hidden) refreshLive();
    }, 60000);
  }

  /* ---------------- wire up ---------------- */

  document.addEventListener('DOMContentLoaded', function () {
    A = window.PHLO; el = A.el; toast = A.toast;
    $('dp-plan').addEventListener('click', planRoutes);
    $('dp-print').addEventListener('click', printRoutes);
    $('dp-send').addEventListener('click', sendRoutes);
    $('dp-live-refresh').addEventListener('click', refreshLive);
    document.querySelectorAll('[data-dptool]').forEach(function (b) { b.addEventListener('click', function () { setDpTool(b.getAttribute('data-dptool')); }); });
    $('dp-sel-apply').addEventListener('click', applySel);
    $('dp-sel-clear').addEventListener('click', clearSel);
    var pad = $('dp-draw');
    pad.addEventListener('pointerdown', lassoStart);
    pad.addEventListener('pointermove', lassoMove);
    pad.addEventListener('pointerup', lassoEnd);
    pad.addEventListener('pointercancel', lassoEnd);
    pad.addEventListener('wheel', lassoWheel, { passive: false });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && A.view() === 'dispatch' && selected().length && !document.querySelector('dialog[open]')) clearSel(); });
    $('dp-live-date').addEventListener('change', refreshLive);
    // A new max re-splits the stops (keeping stops moved by hand) without looking addresses up again.
    try { var savedMax = localStorage.getItem('phlo.maxStops'); if (savedMax) $('dp-max').value = savedMax; } catch (e) { /* storage blocked */ }
    $('dp-max').addEventListener('change', function () {
      try { localStorage.setItem('phlo.maxStops', $('dp-max').value); } catch (e) { /* storage blocked */ }
      if (!plan) return;
      var manual = {};
      plan.stops.forEach(function (s) { if (s.manual) manual[s.id] = s.driverId; });
      assign(manual);
      note('Re-planning…');
      Promise.all(plan.drivers.map(routeDriver)).then(afterPlan);
    });
    ['dp-start', 'dp-service'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        if (!plan) return;
        Promise.all(plan.drivers.map(routeDriver)).then(afterPlan);
      });
    });
    document.addEventListener('phlo:rows', function () {
      plan = null; dmap.fittedFor = null; dmap.sel = {};
      ['dp-flags-card', 'dp-routes-card'].forEach(function (id) { $(id).hidden = true; });
      $('dp-print').disabled = $('dp-send').disabled = true;
      $('dp-live-date').value = A.deliveryIso();
      renderSummary();
    });
    document.addEventListener('phlo:drivers', renderSummary);
    A.onShow.dispatch = function () { renderSummary(); refreshLive(); startLive(); };
    renderSummary();
  });
})();
