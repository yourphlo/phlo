/**
 * PHLO MASTER BUILDER
 *
 * Reads every pharmacy's PHLO delivery Google Sheet, pulls the rows meant for
 * one delivery day, and writes them into a new tab of this spreadsheet in the
 * master upload format:
 *
 *     NAME | ADDRESS | NOTES | NOTES 2
 *     "RX#,LAST,FIRST" | street city state zip | store code | copay-combo-fridge-notes
 *
 * Which rows are picked (delivery date D, default = tomorrow):
 *   1. A row whose notes name a delivery date ("DEL 10.20.2026", "DELIVERY ON 10/20",
 *      "must be delivered 10/20", "10/20 - MORNING") is used only on that date.
 *   2. Otherwise the row's pickup date must be the day before D (Sat + Sun when D is Monday).
 *      The pickup date comes from the date column (carried down until the next date)
 *      or from a "PHLO PICK UP ON 10/19/2026" banner row, whichever is later.
 *
 * Setup: see README.md in this folder.
 */

var MASTER_HEADERS = ['NAME', 'ADDRESS', 'NOTES', 'NOTES 2'];
var TIME_ZONE = 'America/Los_Angeles';

/**
 * One entry per store, in the order they appear in the master.
 * cols are 0-based column numbers (A=0, B=1, ...).
 *   date    column with the pickup date (optional)
 *   id      RX / log number
 *   name    "NAME, ADDRESS" or "NAME|ADDRESS|PHONE" or "NAME\nADDRESS"
 *   address separate address column (only when name holds just the name)
 *   copay, fridge  optional
 *   notes   list of note columns, joined into NOTES 2
 * tab.prefix  only use monthly tabs whose name starts with this (e.g. RX / DME)
 * onlyIf      skip rows unless this column matches (SG lists other drivers too)
 * xlsx        the source is an .xlsx file in Drive, not a Google Sheet
 * search      find the file by name (newest match) instead of a fixed id
 * tabPerDay   one tab per pickup day named like "Mon 10/19/26"
 */
var STORES = [
  { code: 'VALLEY', title: '986 VLY#8012 PHLO LIST',
    id: '1m5VjllPLEtBgMJYaJeQ1co8RABXN82gB2okz8PFmd-c',
    cols: { date: 0, id: 3, name: 4, fridge: 5, copay: 6, notes: [7] } },
  { code: 'LV', title: '986LV SPREADSHEET',
    id: '1pYrsxKTV0WQpz3m7Kw-CWzum_nEs21O0v0Na6MH9J_Q',
    cols: { date: 0, id: 1, name: 2, copay: 3, notes: [4] } },
  { code: 'WT', title: '986 WHITTIER#8027 (RX tabs)',
    id: '1g7XITE-OcOng74Qhzppv6mCtWGcTjdoHxq17iKOOgTY', tab: { prefix: 'RX' },
    cols: { id: 0, name: 1, copay: 3, fridge: 4, notes: [6] } },
  { code: 'WT DME', title: '986 WHITTIER#8027 (DME tabs)',
    id: '1g7XITE-OcOng74Qhzppv6mCtWGcTjdoHxq17iKOOgTY', tab: { prefix: 'DME' },
    cols: { date: 0, id: 1, name: 2, notes: [3, 4] } },
  { code: 'RM', title: '986 #8030 PHLO DELIVERY SPREADSHEET',
    id: '1BcQSXpKu7sbvaz6AtfB8p1WMAkgM91RlUZVd8Bt0Hrs',
    cols: { date: 0, id: 1, name: 3, copay: 4, fridge: 5, notes: [6] } },
  { code: 'ARC', title: '986 ARCADIA PHLO LIST',
    id: '1I7vb98ZvNSVkN9ovkiaRSlnQ53dHhUtpnhbPMy9exN8',
    cols: { date: 0, id: 1, name: 2, notes: [3, 4, 5] } },
  { code: 'TC', title: 'TEMPLE CITY #8003 PHLO 2026',
    id: '15slSAd-zQg-uKEePGzNp9fZymJBApjGRekIlV3oSdMc',
    cols: { date: 0, id: 3, name: 4, copay: 5, fridge: 6, notes: [7, 8] } },
  { code: 'PDSN', title: '986 PSDN2#8032',
    id: '1tsBfURzPlPH4ZpnZ3gLdVkpy6EDGSKCofut85iMdtC8',
    cols: { date: 0, id: 3, name: 4, fridge: 5, copay: 6, notes: [7] } },
  { code: 'WSTR', title: '986 Westminster PHLO#8020',
    id: '1yJWPdFZaybRhW1VlqFRTaaw3z5R-SjXhlPUyL6kyO9M',
    cols: { date: 0, id: 3, name: 4, fridge: 5, copay: 6, notes: [7] } },
  { code: 'ARC2', title: 'Arcadia KM2 PHLO 2026.xlsx',
    id: '1sojU9EHFQ9wBoTH48TLZQY0Onop8DByp', xlsx: true,
    cols: { date: 0, id: 3, name: 4, copay: 5, fridge: 6, notes: [7] } },
  { code: 'BP', title: '986 BP PHLO (newest monthly file)',
    search: { titleContains: ['BP', 'PHLO'] }, tabPerDay: true,
    cols: { id: 2, name: 3, notes: [7], copay: 8 } },
  { code: 'SG', title: '986 SG#8037 (121460) - DELIVERY LOG',
    id: '1l_2pDmXwADKir-kHDxGqNUmany4NRFN4BEk_1YfDmfw',
    onlyIf: { col: 4, pattern: 'phlo' },
    cols: { date: 0, id: 1, name: 2, address: 3, notes: [5, 6] } },
  { code: 'EM', title: '986 EM#8000 PHLO',
    id: '1MwxHnyDnKRRYZTmXD42Xm7V48C-wvmlsa1a5k-yYgkw',
    cols: { date: 0, id: 1, name: 2, notes: [3] } }
];

/* =========================== MENU / ENTRY POINTS =========================== */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('PHLO')
    .addItem("Build master for tomorrow's deliveries", 'buildMasterTomorrow')
    .addItem('Build master for a date…', 'buildMasterPrompt')
    .addSeparator()
    .addItem('Save current tab as .xlsx in Drive', 'exportActiveTabXlsx')
    .addToUi();
}

function buildMasterTomorrow() {
  var today = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd').split('-');
  var d = phloUtc(+today[0], +today[1], +today[2]);
  buildMaster(phloAddDays(d, 1));
}

function buildMasterPrompt() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('PHLO master', 'Delivery date (MM/DD/YY):', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var m = res.getResponseText().match(/(\d{1,2})\D(\d{1,2})\D(\d{2,4})/);
  if (!m) { ui.alert('Could not read that date. Use MM/DD/YY.'); return; }
  var y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
  buildMaster(phloUtc(y, +m[1], +m[2]));
}

/** Builds the master tab for delivery date `delivery` (a UTC-midnight Date). */
function buildMaster(delivery) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rows = [];
  var log = [];
  STORES.forEach(function (store) {
    try {
      var values = phloReadStore(store, delivery);
      if (!values) { log.push(store.code + ': source not found (skipped)'); return; }
      var out = phloStoreRows(values, store, delivery);
      rows = rows.concat(out);
      log.push(store.code + ': ' + out.length + ' row(s)');
    } catch (e) {
      log.push(store.code + ': ERROR ' + e.message);
    }
  });

  var tabName = phloFmt(delivery, 'MM.dd.yy');
  var sheet = ss.getSheetByName(tabName);
  if (sheet) sheet.clear(); else sheet = ss.insertSheet(tabName, 0);
  var data = [MASTER_HEADERS].concat(rows);
  sheet.getRange(1, 1, data.length, 4).setNumberFormat('@').setValues(data);
  sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  sheet.setColumnWidth(1, 420).setColumnWidth(2, 360).setColumnWidth(3, 70).setColumnWidth(4, 380);
  sheet.setFrozenRows(1);
  ss.setActiveSheet(sheet);

  SpreadsheetApp.getUi().alert('Master ' + tabName + ' built: ' + rows.length + ' rows.\n\n' + log.join('\n') +
    '\n\nUse PHLO > Save current tab as .xlsx to get the upload file.');
}

/** Saves the active tab as "<tab>_UPLOAD.xlsx" next to this spreadsheet and shows a link. */
function exportActiveTabXlsx() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  var url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx&gid=' + sheet.getSheetId();
  var blob = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } })
    .getBlob().setName(sheet.getName() + '_UPLOAD.xlsx');
  var parents = DriveApp.getFileById(ss.getId()).getParents();
  var file = parents.hasNext() ? parents.next().createFile(blob) : DriveApp.createFile(blob);
  var html = HtmlService.createHtmlOutput('<p>Saved <b>' + file.getName() + '</b></p><p><a target="_blank" href="' +
    file.getDownloadUrl() + '">Download</a> · <a target="_blank" href="' + file.getUrl() + '">Open in Drive</a></p>')
    .setWidth(360).setHeight(120);
  SpreadsheetApp.getUi().showModalDialog(html, 'PHLO upload file');
}

/* ============================ READING SOURCES ============================== */

/** Returns the store's rows (display values) from the tabs that can hold this delivery. */
function phloReadStore(store, delivery) {
  var fileId = store.id;
  if (!fileId && store.search) fileId = phloSearchNewest(store.search);
  if (!fileId) return null;

  var tempId = null;
  var book;
  if (store.xlsx) {
    // Convert the .xlsx to a temporary Google Sheet so it can be read (needs the Drive advanced service).
    tempId = Drive.Files.copy({ name: 'tmp PHLO ' + store.code, mimeType: MimeType.GOOGLE_SHEETS }, fileId).id;
    book = SpreadsheetApp.openById(tempId);
  } else {
    book = SpreadsheetApp.openById(fileId);
  }
  try {
    var sheets = book.getSheets();
    var values = [];
    if (store.tabPerDay) {
      // Tab names carry the pickup date ("Mon 10/19/26"); tag each tab's rows with it.
      sheets.forEach(function (sh) {
        var dt = phloParseDate(sh.getName(), delivery, true);
        if (!dt || dt > delivery || dt < phloAddDays(delivery, -7)) return;
        values.push(['PHLO PICK UP ON ' + phloFmt(dt, 'MM/dd/yyyy')]); // read like a banner row
        values = values.concat(sh.getDataRange().getDisplayValues());
      });
      return values;
    }
    var tabs = phloPickTabs(sheets.map(function (s) { return s.getName(); }), delivery, store.tab || {});
    tabs.forEach(function (name) {
      values = values.concat(book.getSheetByName(name).getDataRange().getDisplayValues());
    });
    return values;
  } finally {
    if (tempId) DriveApp.getFileById(tempId).setTrashed(true);
  }
}

function phloSearchNewest(search) {
  var q = search.titleContains.map(function (t) { return "title contains '" + t + "'"; }).join(' and ') +
    " and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false";
  var it = DriveApp.searchFiles(q);
  var best = null;
  while (it.hasNext()) {
    var f = it.next();
    if (!best || f.getLastUpdated() > best.getLastUpdated()) best = f;
  }
  return best ? best.getId() : null;
}

/* ============================ PURE LOGIC ===================================
 * Everything below works on plain arrays so it can be tested outside Google.
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

/** Monthly tabs to read: every month from 7 days before the delivery up to the delivery. */
function phloPickTabs(names, delivery, tabOpt) {
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

    var notesRaw = (c.notes || []).map(cell).filter(function (n) { return n.trim() !== ''; });
    var explicit = null;
    notesRaw.some(function (n) { explicit = phloExplicitDate(n, delivery); return !!explicit; });

    var entry = {
      ids: ids, name: na[0], address: na[1], copay: '', fridge: false, notes: [], combo: false
    };
    var copayCell = c.copay !== undefined ? cell(c.copay) : '';
    entry.copay = phloMoney(copayCell);
    if (/PAID/i.test(copayCell)) entry.notes.push('PAID');
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
      if (last && na[1]) last.extra.push(entry);
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
