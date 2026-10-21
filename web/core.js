/**
 * PHLO master logic - shared by the web app (web/app.js), the Apps Script and the tests.
 * Plain global functions on purpose: works as a browser <script>, an Apps Script file,
 * and in Node via vm. Edit here, then run `node scripts/sync-apps-script.js`.
 */


var PHLO_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function phloUtc(y, m, d) { return new Date(Date.UTC(y, m - 1, d)); }
function phloAddDays(dt, n) { return new Date(dt.getTime() + n * 86400000); }
function phloSameDay(a, b) { return a && b && a.getTime() === b.getTime(); }
function phloFmt(dt, pattern) {
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return pattern.replace('yyyy', dt.getUTCFullYear()).replace('MM', p(dt.getUTCMonth() + 1))
    .replace('dd', p(dt.getUTCDate())).replace('yy', String(dt.getUTCFullYear()).slice(2));
}

/** Month/day from text; the year is whichever puts the date closest to `ref` (typos like 20026 are common). */
function phloDateFromMD(m, d, ref) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  var best = null;
  [-1, 0, 1].forEach(function (k) {
    var c = phloUtc(ref.getUTCFullYear() + k, m, d);
    if (!best || Math.abs(c - ref) < Math.abs(best - ref)) best = c;
  });
  return best;
}

/** Parses a cell that is a date. `loose` allows the date anywhere in the text (tab names). */
function phloParseDate(text, ref, loose) {
  text = String(text || '').trim();
  var m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return phloDateFromMD(+m[2], +m[3], ref);
  m = loose ? text.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.]\d{2,5})?/)
            : text.match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.]\d{2,5})?$/);
  return m ? phloDateFromMD(+m[1], +m[2], ref) : null;
}

/** Pickup dates that feed delivery date D: the day before, plus Saturday when that day is Sunday. */
function phloPickupDates(delivery) {
  var prev = phloAddDays(delivery, -1);
  var out = [prev];
  if (prev.getUTCDay() === 0) out.push(phloAddDays(delivery, -2));
  return out;
}

/**
 * Tabs to read: every monthly tab from 7 days before the delivery up to the delivery,
 * or the one tab named in tabOpt.name (a store that keeps everything on one tab).
 */
function phloPickTabs(names, delivery, tabOpt) {
  if (tabOpt.name) {
    return names.filter(function (n) { return n.trim().toUpperCase() === tabOpt.name.toUpperCase(); });
  }
  var wanted = [];
  [phloAddDays(delivery, -7), delivery].forEach(function (dt) {
    var key = dt.getUTCFullYear() + '-' + dt.getUTCMonth();
    if (wanted.indexOf(key) < 0) wanted.push(key);
  });
  var picked = [];
  wanted.forEach(function (key) {
    var year = +key.split('-')[0], mon = +key.split('-')[1];
    names.forEach(function (name) {
      var up = name.toUpperCase().trim();
      if (/^COPY OF|TEMPLATE|TEST/.test(up)) return;
      if (tabOpt.prefix && up.indexOf(tabOpt.prefix.toUpperCase()) !== 0) return;
      var words = up.replace(/[^A-Z0-9]+/g, ' ').trim().split(' ');
      var hasMonth = words.some(function (w) { return w.length >= 3 && w.slice(0, 3) === PHLO_MONTHS[mon] && /^[A-Z]+$/.test(w); });
      var hasYear = words.indexOf(String(year)) >= 0;
      if (hasMonth && hasYear && picked.indexOf(name) < 0) picked.push(name);
    });
  });
  return picked;
}

var PHLO_PHONE = /,?\s*\(?\b\d{3}\)?[\s.\-]?\d{3}[\s.\-]\d{4}\b/g;

function phloCleanAddress(a) {
  return String(a || '')
    .replace(PHLO_PHONE, ' ')
    .replace(/\*\*[^*]*\*\*/g, ' ')
    .replace(/[,|]/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/\b(\d{5})\d{4}$/, '$1');
}

/** Splits "NAME, ADDRESS" / "NAME|ADDRESS|PHONE" / "NAME\nADDRESS\nPHONE" into [name, address]. */
function phloSplitNameAddress(text) {
  text = String(text || '');
  if (text.indexOf('|') >= 0) {
    var p = text.split('|');
    return [p[0].trim(), phloCleanAddress(p[1])];
  }
  var flat = text.split(/\r?\n/).filter(function (l) { return l.replace(PHLO_PHONE, '').trim() !== ''; })
    .join(' ').replace(/，/g, ',');
  var m = flat.match(/(^|[\s,.;])(\d+[A-Z]?\s+\S)/i);
  if (!m) return [flat.replace(/[\s,]+$/, '').trim(), ''];
  var cut = m.index + m[1].length;
  var before = flat.slice(0, cut);
  if (/\s-\s+$/.test(before)) before = before.replace(/\s-\s+$/, ''); // "NAME - 123 ST" separator
  return [before.replace(/[\s,]+$/, '').replace(/\s+/g, ' ').trim(), phloCleanAddress(flat.slice(cut))];
}

/** Finds a delivery date written in a note. */
function phloExplicitDate(note, ref) {
  var s = String(note || '');
  var m = s.match(/\bDEL(?:IVER(?:Y|ED)?)?\b[^0-9\n]{0,25}?(\d{1,2})[\/.\-](\d{1,2})(?!\d)/i) ||
          s.match(/^\s*(\d{1,2})\/(\d{1,2})(?!\d)/);
  return m ? phloDateFromMD(+m[1], +m[2], ref) : null;
}

function phloCleanNote(note) {
  var s = String(note || '');
  s = s.replace(/(?:\bMUST\s+BE\s+|\bPLEASE\s+)?\bDEL(?:IVER(?:Y|ED)?)?\b[^0-9\n]{0,25}?\d{1,2}[\/.\-]\d{1,2}(?:[\/.\-]\d{2,4})?(?:\s*-\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?/ig, ' ')
       .replace(/^\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\s*-?\s*/, ' ')
       .replace(/\bBAG\s*\d+\s*OF\s*\d+\b/ig, ' ')
       .replace(/\b\d+\s+OF\s+\d+\b/ig, ' ')
       .replace(/\(?\bWITH\s+[A-Z][A-Z ,.'\-]*\)?/ig, ' ')
       .replace(/\bCOMBO\b(\s*W\/.*$|\s*X\s*\d+)?/ig, ' ')
       .replace(/\b(FRIDGE|REFRIG\w*|REFREG\w*)(\s+ITEMS?)?\b/ig, ' ')
       .replace(/[⬇⬆️]/g, ' ')
       .replace(/\s+/g, ' ');
  return s.replace(/^[\s\-,.\/]+|[\s\-,\/]+$/g, '').trim();
}

function phloMoney(text) {
  var s = String(text || '').trim();
  var m = s.match(/^\$?\s*(\d+(?:\.\d+)?)/);
  if (!m || +m[1] === 0) return '';
  return '$' + (+m[1]).toFixed(2);
}

/** Bag count for NOTES 2: "4" -> "4 BAGS", "(3 BAGS/ 1 BOX)" -> "3 BAGS/ 1 BOX"; one bag is not noted. */
function phloBags(text) {
  var s = String(text || '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s || /^\d{5,}$/.test(s)) return ''; // empty, or an RX number typed in the wrong column
  if (/^\d+$/.test(s)) return +s > 1 ? s + ' BAGS' : '';
  return s.toUpperCase();
}

function phloIsFridge(text) { return /^(YES|Y|1|TRUE|FRIDGE|REFRIG)/i.test(String(text || '').trim()); }

/** Reads raw store rows into entries for delivery date D (no grouping yet). */
function phloExtract(values, store, delivery) {
  var c = store.cols;
  var pickups = phloPickupDates(delivery);
  var rowDate = null, banner = null;
  var entries = [];
  var last = null; // last kept entry, for rows that continue it

  values.forEach(function (row) {
    var cell = function (i) { return i === undefined || i >= row.length ? '' : String(row[i] == null ? '' : row[i]); };
    var joined = row.join(' ');
    var b = joined.match(/PICK\s*UP\s*ON\s*(\d{1,2})[\/\-.](\d{1,2})/i);
    if (b) { banner = phloDateFromMD(+b[1], +b[2], delivery); last = null; return; }
    if (c.date !== undefined) {
      var d = phloParseDate(cell(c.date), delivery);
      if (d) rowDate = d;
    }
    var pickup = rowDate && banner ? (rowDate > banner ? rowDate : banner) : (rowDate || banner);

    var idText = cell(c.id).trim();
    var nameText = cell(c.name);
    var addrText = c.address !== undefined ? cell(c.address) : '';
    if (/[A-Z]/i.test(idText) && /^\d{5,}\s*,/.test(idText)) { // "1416950,NAME" with address in the next column
      addrText = nameText;
      nameText = idText.replace(/^\d+\s*,/, '');
      idText = idText.match(/^\d+/)[0];
    }
    var ids = idText.match(/\d{5,}/g) || [];
    var na = addrText ? [nameText.replace(/[\s,]+$/, '').trim(), phloCleanAddress(addrText)] : phloSplitNameAddress(nameText);
    if (!na[0]) return;
    if (store.nameNotes) { // "MOUNTAIN CREST ***DELIVER FROM 8AM TO 5PM ONLY***" -> note
      var starNotes = [];
      na[0] = na[0].replace(/\*{2,}\s*([^*]+?)\s*\*{2,}/g, function (_, t) { starNotes.push(t); return ' '; }).replace(/\s+/g, ' ').trim();
    }

    var notesRaw = (c.notes || []).map(cell).filter(function (n) { return n.trim() !== ''; });
    var explicit = null;
    notesRaw.some(function (n) { explicit = phloExplicitDate(n, delivery); return !!explicit; });

    var entry = {
      ids: ids, name: na[0], address: na[1], copay: '', fridge: false, notes: [], combo: false
    };
    var copayCell = c.copay !== undefined ? cell(c.copay) : '';
    entry.copay = phloMoney(copayCell);
    if (/PAID/i.test(copayCell)) entry.notes.push('PAID');
    if (c.bags !== undefined) { var bags = phloBags(cell(c.bags)); if (bags) entry.notes.push(bags); }
    if (starNotes) starNotes.forEach(function (t) { entry.notes.push(t); });
    if (c.fridge !== undefined && phloIsFridge(cell(c.fridge))) entry.fridge = true;
    notesRaw.forEach(function (n) {
      if (/\b(FRIDGE|REFRIG|REFREG)/i.test(n)) entry.fridge = true;
      if (/\bCOMBO\b|\bBAG\s*\d+\s*OF\s*\d+/i.test(n)) entry.combo = true;
      var cleaned = phloCleanNote(n);
      if (!cleaned) return;
      if (/^\$?\s*\d+(\.\d+)?$/.test(cleaned) && !entry.copay) { entry.copay = phloMoney(cleaned); return; }
      entry.notes.push(cleaned);
    });

    if (!ids.length) {
      // No RX number: a second patient written under the previous row (needs an address to count).
      if (last && /\d/.test(na[1])) last.extra.push(entry);
      return;
    }
    if (store.onlyIf && !new RegExp(store.onlyIf.pattern, 'i').test(cell(store.onlyIf.col))) { last = null; return; }

    var keep = explicit ? phloSameDay(explicit, delivery)
                        : pickups.some(function (p) { return phloSameDay(p, pickup); });
    if (!keep) { last = null; return; }
    entry.extra = [];
    entries.push(entry);
    last = entry;
  });

  // fold continuation rows in
  var flat = [];
  entries.forEach(function (e) { flat.push(e); e.extra.forEach(function (x) { x.cont = true; flat.push(x); }); });
  return flat;
}

/** Key that matches two addresses at the same house/unit despite small spelling differences. */
function phloAddressKey(address) {
  var up = String(address || '').toUpperCase();
  var num = up.match(/^\s*(\d+)/);
  var zip = up.match(/\b(\d{5})(?:-?\d{4})?\s*$/);
  if (!num || !zip) return null;
  var unit = up.match(/(?:\bAPT|\bUNIT|\bSPC|\bSPACE|\bSTE|\bSP|\bBLDG|#)\.?\s*#?\s*([A-Z]?-?\d+[A-Z]?)/);
  var words = up.slice(num[0].length).trim().split(/\s+/).filter(function (w) {
    return ['N', 'S', 'E', 'W', 'N.', 'S.', 'E.', 'W.', 'NORTH', 'SOUTH', 'EAST', 'WEST', '1/2'].indexOf(w) < 0;
  });
  return [num[1], zip[1], unit ? unit[1].replace('-', '') : '', words.length ? words[0][0] : ''].join('|');
}

function phloHouseNumber(address) { var m = String(address || '').match(/^\s*(\d+)/); return m ? m[1] : ''; }

/** Groups same-address patients into one combo row and formats the master rows. */
function phloStoreRows(values, store, delivery) {
  var entries = phloExtract(values, store, delivery);
  var groups = [];
  var byKey = {};
  var prev = null;
  entries.forEach(function (e) {
    var key = phloAddressKey(e.address);
    var g = null;
    if (e.cont && prev) g = prev;
    else if (key && byKey[key]) g = byKey[key];
    else if (prev && e.ids.length && prev.ids.indexOf(e.ids[0]) >= 0) g = prev;
    else if (prev && e.combo && prev.combo && phloHouseNumber(e.address) &&
             phloHouseNumber(e.address) === phloHouseNumber(prev.address)) g = prev; // marked COMBO, address typo
    if (!g) {
      g = { ids: [], names: [], address: e.address, copays: [], fridge: false, notes: [], combo: e.combo };
      groups.push(g);
      if (key) byKey[key] = g;
    }
    e.ids.forEach(function (id) { if (g.ids.indexOf(id) < 0) g.ids.push(id); });
    var nm = e.name.replace(/\s+/g, ' ').trim();
    if (g.names.map(function (n) { return n.toUpperCase(); }).indexOf(nm.toUpperCase()) < 0) g.names.push(nm);
    if (e.copay && g.copays.indexOf(e.copay) < 0) g.copays.push(e.copay);
    g.fridge = g.fridge || e.fridge;
    e.notes.forEach(function (n) { if (g.notes.indexOf(n) < 0) g.notes.push(n); });
    prev = g;
  });

  return groups.map(function (g) {
    var combo = g.names.length > 1;
    var name = g.ids.join(', ') + ',' + g.names.join(', & ');
    var notes2 = [].concat(g.copays, combo ? ['COMBO'] : [], g.fridge ? ['FRIDGE'] : [], g.notes).join('-');
    return [name, g.address, store.code, notes2];
  });
}

/* ============================ CHECKS ====================================== */

/** RX numbers in a master NAME cell ("5147457, 5147468,RIVERA,..." -> ["5147457", "5147468"]). */
function phloRxNumbers(name) { return String(name || '').match(/\d{5,}/g) || []; }

var PHLO_STREET = /(?:^|[\s.,])(\d{3,6})\s+(?:[NSEW]\.?\s+)?[A-Z][A-Z']+(?:\s+[A-Z']+)?\s+(?:ST|AVE|AVENUE|BLVD|RD|DR|LN|LANE|WAY|CT|PL|CIR|PKWY|PARKWAY|HWY|STREET|DRIVE|ROAD)\b\.?/gi;

/**
 * Looks over master rows ([NAME, ADDRESS, NOTES, NOTES 2]) for things a person should check.
 * Returns [{row (0-based), level: 'error'|'warn'|'info', message}].
 */
function phloCheckRows(rows) {
  var out = [];
  var seenRx = {};
  var seenAddr = {};
  rows.forEach(function (r, i) {
    var name = String(r[0] || ''), addr = String(r[1] || '').trim(), code = String(r[2] || '');
    var rx = phloRxNumbers(name);
    if (!rx.length) out.push({ row: i, level: 'error', message: 'No RX number in NAME' });
    var lastRx = rx.length ? name.lastIndexOf(rx[rx.length - 1]) : -1;
    if (lastRx > 0 && /[A-Z]/i.test(name.slice(0, lastRx)))
      out.push({ row: i, level: 'error', message: 'Stray letters between RX numbers: "' + name.slice(0, lastRx + rx[rx.length - 1].length) + '"' });
    rx.forEach(function (n) {
      if (n.length !== 7) out.push({ row: i, level: 'warn', message: 'RX ' + n + ' has ' + n.length + ' digits (most have 7)' });
      if (seenRx[n] !== undefined) out.push({ row: i, level: 'warn', message: 'RX ' + n + ' is also on row ' + (seenRx[n] + 2) });
      else seenRx[n] = i;
    });
    if (!addr) { out.push({ row: i, level: 'error', message: 'No address' }); return; }
    var zip = addr.match(/(\d+)\s*$/);
    if (!zip) out.push({ row: i, level: 'warn', message: 'Address does not end in a ZIP code' });
    else if (zip[1].length !== 5) out.push({ row: i, level: 'warn', message: 'ZIP "' + zip[1] + '" has ' + zip[1].length + ' digits' });
    var streets = addr.match(PHLO_STREET) || [];
    if (streets.length > 1) out.push({ row: i, level: 'warn', message: 'Looks like two addresses: ' + streets.map(function (s) { return s.trim(); }).join(' / ') });
    var key = phloAddressKey(addr);
    if (key && seenAddr[key] !== undefined)
      out.push({ row: i, level: 'info', message: 'Same address as row ' + (seenAddr[key] + 2) + ' - combine?' });
    else if (key) seenAddr[key] = i;
    if (!code) out.push({ row: i, level: 'error', message: 'No store code in NOTES' });
  });
  return out;
}

/**
 * Compares a finished master (rows from an .xlsx) with what the store sheets hold.
 * Returns {stores: [{code, missing: [rows from sources], extra: [rows from file]}], checks}.
 */
function phloCompare(builtRows, fileRows) {
  var byCode = {};
  var add = function (rows, side) {
    rows.forEach(function (r) {
      var code = String(r[2] || '').trim();
      if (!code) return;
      byCode[code] = byCode[code] || { built: {}, file: {} };
      phloRxNumbers(r[0]).forEach(function (n) { byCode[code][side][n] = r; });
    });
  };
  add(builtRows, 'built');
  add(fileRows, 'file');
  var stores = Object.keys(byCode).map(function (code) {
    var c = byCode[code];
    var missing = [], extra = [];
    Object.keys(c.built).forEach(function (n) { if (!c.file[n] && missing.indexOf(c.built[n]) < 0) missing.push(c.built[n]); });
    Object.keys(c.file).forEach(function (n) { if (!c.built[n] && extra.indexOf(c.file[n]) < 0) extra.push(c.file[n]); });
    return { code: code, inSources: Object.keys(c.built).length, inFile: Object.keys(c.file).length, missing: missing, extra: extra };
  });
  return { stores: stores, checks: phloCheckRows(fileRows) };
}
