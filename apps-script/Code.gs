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

var TIME_ZONE = 'America/Los_Angeles';

/* Store list: Stores.gs.  Parsing logic: Core.gs (both copied from web/). */

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
      if (!values) { log.push(store.code + (store.id || store.search ? ': source not found (skipped)' : ': paste its cells on the web page (skipped)')); return; }
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

