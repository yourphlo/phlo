/* PHLO delivery history: every master's RX (ticket) numbers by delivery date, which ones were
 * delivered, and which must be carried into the next master because nobody confirmed them.
 * Pure functions (no page or Google code) so test/run.js can check them in Node.
 *
 * Saved file: {version, updatedAt, days: {'YYYY-MM-DD': day}}
 *   day = {rows: [[NAME, ADDRESS, NOTES, NOTES 2]], source, savedAt, status: {rx: 'delivered'|'missed'}, routific}
 *   source: 'download' (the .xlsx you downloaded), 'file' (a finished file you checked),
 *           'built' (built in the app), 'rebuilt' (rebuilt from the store sheets as a past day)
 *   An RX with no status is not confirmed delivered, so it keeps coming back. */

var PHLO_HISTORY_LOOKBACK = 4;   // past delivery days rebuilt from the store sheets on every build
var PHLO_HISTORY_KEEP_DAYS = 90; // fully delivered days older than this are dropped
var PHLO_SOURCE_RANK = { rebuilt: 0, built: 1, file: 2, download: 3 };

function phloHistoryDay(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  var status = {};
  Object.keys(raw.status || {}).forEach(function (rx) {
    var s = raw.status[rx];
    if (/^\d{5,}$/.test(rx) && (s === 'delivered' || s === 'missed')) status[rx] = s;
  });
  return {
    rows: (Array.isArray(raw.rows) ? raw.rows : []).filter(Array.isArray).map(function (r) {
      return [0, 1, 2, 3].map(function (i) { return r[i] == null ? '' : String(r[i]); });
    }),
    source: PHLO_SOURCE_RANK[raw.source] !== undefined ? raw.source : 'built',
    savedAt: raw.savedAt || '',
    status: status,
    // RX numbers "Mark the rest delivered" ticked, so it can be undone. Only those still delivered count.
    bulk: (Array.isArray(raw.bulk) ? raw.bulk : []).map(String).filter(function (rx, i, a) {
      return status[rx] === 'delivered' && a.indexOf(rx) === i;
    }),
    routific: raw.routific && typeof raw.routific === 'object' ? raw.routific : null
  };
}

/** The saved history file. Tolerates missing or old fields. */
function phloHistoryData(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  var days = {};
  Object.keys(raw.days || {}).forEach(function (iso) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) days[iso] = phloHistoryDay(raw.days[iso]);
  });
  return { version: 1, updatedAt: raw.updatedAt || '', days: days };
}

/** Every RX number on a day's master. */
function phloDayRx(day) {
  var out = [];
  day.rows.forEach(function (r) { phloRxNumbers(r[0]).forEach(function (n) { if (out.indexOf(n) < 0) out.push(n); }); });
  return out;
}

/**
 * Saves the master rows for one delivery date. A lower-ranked source never replaces a higher one
 * (a rebuild does not overwrite the file you downloaded). Delivered/missed marks are kept.
 * Returns true when it changed anything.
 */
function phloSaveDay(hist, iso, rows, source, nowIso) {
  var old = hist.days[iso];
  if (old && old.rows.length && PHLO_SOURCE_RANK[source] < PHLO_SOURCE_RANK[old.source]) return false;
  var day = phloHistoryDay({ rows: rows, source: source, savedAt: nowIso, status: old ? old.status : {}, bulk: old ? old.bulk : [], routific: old ? old.routific : null });
  if (old && JSON.stringify(old.rows) === JSON.stringify(day.rows) && old.source === day.source) return false;
  hist.days[iso] = day;
  // A Routific stops export dropped earlier still applies to the new rows.
  if (day.routific && day.routific.stops) phloApplyRoutific(hist, iso, day.routific);
  return true;
}

/** Marks RX numbers on one day as 'delivered', 'missed', or null (not confirmed). */
function phloMarkRx(hist, iso, rxList, status) {
  var day = hist.days[iso];
  if (!day) return;
  rxList.forEach(function (rx) {
    if (status) day.status[rx] = status; else delete day.status[rx];
  });
}

/** RX numbers "Mark the rest delivered" ticked on one day that are still delivered (what Undo would clear). */
function phloBulkRx(hist, iso) {
  var day = hist.days[iso];
  return day ? (day.bulk || []).filter(function (rx) { return day.status[rx] === 'delivered'; }) : [];
}

/** "Mark the rest delivered": every unconfirmed RX on the day becomes delivered. Returns how many. */
function phloMarkRest(hist, iso) {
  var day = hist.days[iso];
  if (!day) return 0;
  var rest = phloDayRx(day).filter(function (rx) { return !day.status[rx]; });
  phloMarkRx(hist, iso, rest, 'delivered');
  day.bulk = phloBulkRx(hist, iso).concat(rest);
  return rest.length;
}

/** Puts every delivered RX on one day back to not confirmed (not-delivered ones stay). Returns how many.
 * Used to undo days marked before the app remembered which tickets "Mark the rest delivered" ticked. */
function phloUnmarkDelivered(hist, iso) {
  var day = hist.days[iso];
  if (!day) return 0;
  var rx = Object.keys(day.status).filter(function (n) { return day.status[n] === 'delivered'; });
  phloMarkRx(hist, iso, rx, null);
  day.bulk = [];
  return rx.length;
}

/** Undo for phloMarkRest: puts the RX it ticked back to not confirmed. Returns how many. */
function phloUndoMarkRest(hist, iso) {
  var day = hist.days[iso];
  if (!day) return 0;
  var rx = phloBulkRx(hist, iso);
  phloMarkRx(hist, iso, rx, null);
  day.bulk = [];
  return rx.length;
}

/**
 * Tickets from saved masters before `iso` that were never confirmed delivered.
 * For each RX the newest saved day that has it decides: delivered there = done.
 * RX numbers already in `currentRows` are skipped (they are on today's master anyway).
 * Returns [{row, rx: [pending RX on that row], lastIso, firstIso, dates, missed}], oldest first.
 */
function phloOutstanding(hist, iso, currentRows) {
  var onToday = {};
  (currentRows || []).forEach(function (r) { phloRxNumbers(r[0]).forEach(function (n) { onToday[n] = true; }); });
  var dates = Object.keys(hist.days).filter(function (d) { return d < iso; }).sort();
  var seen = {}; // rx -> {lastIso, row, dates}
  dates.forEach(function (d) {
    hist.days[d].rows.forEach(function (r) {
      phloRxNumbers(r[0]).forEach(function (n) {
        var s = seen[n] || (seen[n] = { dates: [] });
        s.lastIso = d; s.row = r;
        if (s.dates.indexOf(d) < 0) s.dates.push(d);
      });
    });
  });
  var byRow = [];
  Object.keys(seen).forEach(function (n) {
    var s = seen[n];
    if (onToday[n]) return;
    var st = hist.days[s.lastIso].status[n];
    if (st === 'delivered') return;
    var item = byRow.filter(function (x) { return x.row === s.row; })[0];
    if (!item) {
      item = { row: s.row, rx: [], lastIso: s.lastIso, firstIso: s.dates[0], dates: s.dates.slice(), missed: false };
      byRow.push(item);
    }
    item.rx.push(n);
    if (st === 'missed') item.missed = true;
    if (s.dates[0] < item.firstIso) item.firstIso = s.dates[0];
  });
  byRow.sort(function (a, b) { return a.firstIso < b.firstIso ? -1 : a.firstIso > b.firstIso ? 1 : 0; });
  return byRow;
}

/** Counts for one saved day: {total, delivered, missed, open}. */
function phloDayCounts(day) {
  var rx = phloDayRx(day), c = { total: rx.length, delivered: 0, missed: 0, open: 0 };
  rx.forEach(function (n) {
    var s = day.status[n];
    if (s === 'delivered') c.delivered++; else if (s === 'missed') c.missed++; else c.open++;
  });
  return c;
}

/** The `n` delivery days before `iso` (Sundays skipped: no deliveries), newest first. */
function phloLookbackDays(iso, n) {
  var p = iso.split('-'), d = phloUtc(+p[0], +p[1], +p[2]), out = [];
  while (out.length < n) {
    d = phloAddDays(d, -1);
    if (d.getUTCDay() !== 0) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Drops fully delivered days older than PHLO_HISTORY_KEEP_DAYS. Days with open tickets are kept. */
function phloPruneHistory(hist, todayIso) {
  var p = todayIso.split('-');
  var cutoff = phloAddDays(phloUtc(+p[0], +p[1], +p[2]), -PHLO_HISTORY_KEEP_DAYS).toISOString().slice(0, 10);
  Object.keys(hist.days).forEach(function (iso) {
    if (iso >= cutoff) return;
    var c = phloDayCounts(hist.days[iso]);
    if (c.open + c.missed === 0) delete hist.days[iso];
  });
}

/** Combines two copies of the history (this device and Google): newest rows per day, all marks kept. */
function phloMergeHistory(a, b) {
  var out = phloHistoryData(null);
  out.updatedAt = (a.updatedAt || '') > (b.updatedAt || '') ? a.updatedAt : b.updatedAt;
  var dates = Object.keys(a.days).concat(Object.keys(b.days));
  dates.forEach(function (iso) {
    if (out.days[iso]) return;
    var x = a.days[iso], y = b.days[iso];
    if (!x || !y) { out.days[iso] = phloHistoryDay(x || y); return; }
    var rx = PHLO_SOURCE_RANK[x.source], ry = PHLO_SOURCE_RANK[y.source];
    var newer = rx !== ry ? (rx > ry ? x : y) : ((x.savedAt || '') >= (y.savedAt || '') ? x : y);
    var older = newer === x ? y : x;
    var day = phloHistoryDay(newer);
    Object.keys(older.status).forEach(function (n) { if (!day.status[n]) day.status[n] = older.status[n]; });
    if (!day.routific) day.routific = older.routific;
    day.bulk = phloHistoryDay({ status: day.status, bulk: day.bulk.concat(older.bulk || []) }).bulk;
    out.days[iso] = day;
  });
  return out;
}

/* ---------------- Routific exports ---------------- */

/** Delivery date in a file name: "Routific summary - 10.20.26 - 2026-10-20.csv" -> "2026-10-20". */
function phloDateFromFileName(name, ref) {
  var s = String(name || '');
  var m = s.match(/(20\d\d)-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/(\d{1,2})[.\-_](\d{1,2})[.\-_](\d{2})(?!\d)/);
  if (!m) return null;
  var d = phloDateFromMD(+m[1], +m[2], ref);
  return d ? d.toISOString().slice(0, 10) : null;
}

var PHLO_NOT_DELIVERED = /\b(NOT|UN|FAIL|MISS|SKIP|ATTEMPT|CANCEL|RETURN|RESCHEDUL|PENDING|INCOMPLETE|NO\b)/i;
var PHLO_DELIVERED = /\b(DELIVERED|COMPLETED?|SUCCESS(FUL)?|DONE|YES|TRUE)\b/i;

/**
 * Reads a Routific export (rows from the .csv/.xlsx, header first).
 *  - summary (Driver Name, Time, Distance, Number of Stops): stop counts only, no tickets.
 *  - stops (one row per stop, the NAME column holds the RX numbers): which tickets were
 *    routed, unscheduled, delivered or failed.
 * Returns {kind, drivers: [{name, stops}], routed, unscheduled, stops: [{rx, driver, delivered}], hasStatus}.
 */
function phloParseRoutific(rows) {
  rows = (rows || []).filter(function (r) { return r && r.some(function (c) { return String(c == null ? '' : c).trim() !== ''; }); });
  var out = { kind: 'unknown', drivers: [], routed: 0, unscheduled: 0, stops: [], hasStatus: false };
  if (!rows.length) return out;
  var head = rows[0].map(function (h) { return String(h == null ? '' : h).trim(); });
  var col = function (re) { for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; };
  var driverCol = col(/driver|vehicle|route/i);
  var countCol = col(/number of stops|^stops$|stop count/i);
  var isUnscheduled = function (name) { return /UNSCHEDULED|UNASSIGNED|UNSERVED/i.test(name); };

  // Which column holds the NAME cells ("5147457, 5147468,RIVERA,...")
  var best = -1, bestHits = 0;
  head.forEach(function (_, i) {
    var hits = rows.slice(1).filter(function (r) { return /^\s*\d{5,}(\s*,\s*\d{5,})*\s*,/.test(String(r[i] == null ? '' : r[i])); }).length;
    if (hits > bestHits) { best = i; bestHits = hits; }
  });

  if (countCol >= 0 && best < 0) {
    out.kind = 'summary';
    rows.slice(1).forEach(function (r) {
      var name = String(r[driverCol >= 0 ? driverCol : 0] || '').trim(), n = parseInt(r[countCol], 10) || 0;
      if (isUnscheduled(name)) out.unscheduled += n;
      else { out.routed += n; out.drivers.push({ name: name, stops: n }); }
    });
    return out;
  }
  if (best < 0) return out;

  out.kind = 'stops';
  var statusCol = col(/status|delivered|outcome|result|completed/i);
  out.hasStatus = statusCol >= 0;
  var perDriver = {};
  rows.slice(1).forEach(function (r) {
    var rx = phloRxNumbers(r[best]);
    if (!rx.length) return;
    var driver = driverCol >= 0 ? String(r[driverCol] || '').trim() : '';
    var unscheduled = !driver || isUnscheduled(driver) || (statusCol >= 0 && /UNSCHEDULED|UNASSIGNED/i.test(String(r[statusCol] || '')));
    var delivered;
    if (unscheduled) delivered = false;
    else if (statusCol >= 0) {
      var s = String(r[statusCol] == null ? '' : r[statusCol]).trim();
      delivered = !s ? null : PHLO_NOT_DELIVERED.test(s) ? false : PHLO_DELIVERED.test(s) ? true : null;
    } else delivered = true; // no status column: a routed stop counts as delivered
    if (unscheduled) out.unscheduled++;
    else { out.routed++; perDriver[driver] = (perDriver[driver] || 0) + 1; }
    out.stops.push({ rx: rx, driver: unscheduled ? 'UNSCHEDULED' : driver, delivered: delivered });
  });
  out.drivers = Object.keys(perDriver).map(function (k) { return { name: k, stops: perDriver[k] }; });
  return out;
}

/**
 * Applies a stops export to one saved day. Tickets in the file get delivered/missed; tickets on the
 * master but not in the file stay open. Returns {delivered, missed, unknown, notOnMaster: [rx]}.
 */
function phloApplyRoutific(hist, iso, parsed) {
  var day = hist.days[iso];
  var res = { delivered: 0, missed: 0, unknown: 0, notOnMaster: [] };
  if (!day) return res;
  var onMaster = {};
  phloDayRx(day).forEach(function (n) { onMaster[n] = true; });
  parsed.stops.forEach(function (s) {
    s.rx.forEach(function (n) {
      if (!onMaster[n]) { if (res.notOnMaster.indexOf(n) < 0) res.notOnMaster.push(n); return; }
      if (s.delivered === true) { day.status[n] = 'delivered'; res.delivered++; }
      else if (s.delivered === false) { day.status[n] = 'missed'; res.missed++; }
      else res.unknown++;
    });
  });
  return res;
}
