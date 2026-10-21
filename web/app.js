/* PHLO master web app: reads the store sheets with the signed-in Google account,
 * builds the master with core.js, shows checks, and downloads the upload .xlsx.
 * Also keeps the driver profiles, saved in the user's own Google Drive (hidden app folder).
 * Nothing is sent anywhere except Google's own APIs. */
(function () {
  'use strict';

  var CFG = window.PHLO_CONFIG || {};
  var TZ = CFG.timeZone || 'America/Los_Angeles';
  // drive.appdata = a private app folder in the user's Drive, used only for the saved driver profiles.
  var SCOPES = 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata';
  var SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';
  var DRIVE = 'https://www.googleapis.com/drive/v3/files';

  var $ = function (id) { return document.getElementById(id); };
  var state = { token: null, tokenExpires: 0, tokenClient: null, rows: [], built: null, checks: [] };

  /* ---------------- small helpers ---------------- */

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }

  function todayLocal() {
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-');
    return phloUtc(+parts[0], +parts[1], +parts[2]);
  }
  function isoDate(d) { return d.toISOString().slice(0, 10); }
  function fromIso(s) { var p = s.split('-'); return phloUtc(+p[0], +p[1], +p[2]); }
  function niceDate(d) { return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }); }

  function relTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    var mins = Math.round((Date.now() - d) / 60000);
    if (mins < 1) return 'updated just now';
    if (mins < 60) return 'updated ' + mins + ' min ago';
    var fmt = d.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return 'updated ' + fmt;
  }

  /* ---------------- Google sign-in ---------------- */

  function clientId() {
    var saved = '';
    try { saved = localStorage.getItem('phlo.clientId') || ''; } catch (e) { /* storage blocked */ }
    return CFG.clientId || saved;
  }

  function initAuth() {
    var id = clientId();
    $('setup').hidden = !!id;
    if (!id) return;
    if (state.tokenClient) return;
    if (!(window.google && google.accounts && google.accounts.oauth2)) { setTimeout(initAuth, 200); return; }
    state.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: SCOPES,
      callback: function (resp) {
        if (resp.error) { toast('Sign-in failed: ' + resp.error); return; }
        state.token = resp.access_token;
        state.tokenExpires = Date.now() + (resp.expires_in - 60) * 1000;
        checkAccount().then(function (email) {
          if (state.onToken) { var f = state.onToken; state.onToken = null; f(); }
          afterSignIn(email);
        }, rejectAccount);
      }
    });
  }

  function signIn(then) {
    if (!state.tokenClient && clientId()) initAuth();
    if (!state.tokenClient) {
      toast(clientId() ? 'Google sign-in is still loading. Try again in a moment.' : 'Add the OAuth client ID first (setup box).');
      return;
    }
    state.onToken = then || null;
    state.tokenClient.requestAccessToken({ prompt: state.token ? '' : 'consent' });
  }

  var ALLOWED = (CFG.allowedEmails || []).map(function (e) { return String(e).trim().toLowerCase(); });

  /** Resolves with the signed-in account's email if it is allowed to use the app, else rejects with it. */
  function checkAccount() {
    return fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { Authorization: 'Bearer ' + state.token } })
      .then(function (res) { return res.ok ? res.json() : {}; })
      .then(function (r) {
        var email = String(r.user && r.user.emailAddress || '').toLowerCase();
        if (!email) throw new Error('');
        if (ALLOWED.length && ALLOWED.indexOf(email) < 0) throw new Error(email);
        return email;
      });
  }

  /** Wrong account (or it couldn't be checked): drop its access and stay locked. */
  function rejectAccount(e) {
    var token = state.token, wasIn = state.session;
    state.token = null; state.tokenExpires = 0; state.onToken = null;
    if (token && google.accounts.oauth2.revoke) google.accounts.oauth2.revoke(token, function () {});
    if (wasIn) { location.reload(); return; }
    toast(e && e.message ? e.message + ' can\'t use this app. Sign in with ' + (ALLOWED[0] || 'the PHLO account') + '.' :
      'Could not check which Google account signed in. Try again.');
  }

  function afterSignIn(email) {
    var first = !state.session;
    state.session = true;
    $('who').textContent = email;
    $('signin').hidden = true;
    $('signout').hidden = false;
    $('build').disabled = false;
    $('locked').hidden = true;
    $('tabs').hidden = false;
    if (first) showView(state.view);
    loadDriversFromDrive();
    loadHistoryFromDrive();
  }

  // Signing out reloads the page, which wipes every patient row it was showing (nothing patient-related
  // is kept in the browser). Waits for any history save to Google first so nothing is lost.
  function signOut() {
    var token = state.token;
    clearTimeout(hist.timer);
    var pending = hist.synced || !signedIn() ? Promise.resolve() : pushHistory();
    $('signout').disabled = true;
    Promise.resolve(pending).then(function () {
      if (token && google.accounts.oauth2.revoke) google.accounts.oauth2.revoke(token, function () {});
      state.token = null;
      purgeLocalHistory();
      location.reload();
    });
  }

  function withToken() {
    if (state.token && Date.now() < state.tokenExpires) return Promise.resolve();
    return new Promise(function (resolve) { signIn(resolve); });
  }

  function api(url, asBuffer, init) {
    return withToken().then(function () {
      init = init || {};
      init.headers = Object.assign({ Authorization: 'Bearer ' + state.token }, init.headers || {});
      return fetch(url, init);
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          var msg = (j.error && j.error.message) || res.statusText;
          if (res.status === 404) msg = 'file not found or not shared with you';
          if (res.status === 403) msg = 'no access (' + msg + ')';
          throw new Error(msg);
        });
      }
      return asBuffer ? res.arrayBuffer() : res.json();
    });
  }

  /* ---------------- reading the store sheets ---------------- */

  function quoteTab(name) { return "'" + name.replace(/'/g, "''") + "'"; }

  function findNewest(search) {
    var q = search.titleContains.map(function (t) { return "name contains '" + t.replace(/'/g, "\\'") + "'"; }).join(' and ') +
      " and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false";
    var url = DRIVE + '?q=' + encodeURIComponent(q) + '&orderBy=modifiedTime%20desc&pageSize=1' +
      '&fields=files(id)&includeItemsFromAllDrives=true&supportsAllDrives=true';
    return api(url).then(function (r) { return r.files && r.files[0] ? r.files[0].id : null; });
  }

  /** Resolves to {values, file, tabs} for one store, or null when no file is found. */
  function readStore(store, delivery) {
    var idP = store.id ? Promise.resolve(store.id) : (store.search ? findNewest(store.search) : Promise.resolve(null));
    return idP.then(function (id) {
      if (!id) return null;
      return api(DRIVE + '/' + id + '?fields=name,mimeType,modifiedTime&supportsAllDrives=true').then(function (file) {
        var isSheet = file.mimeType === 'application/vnd.google-apps.spreadsheet';
        return (isSheet ? readGoogleSheet(id, store, delivery) : readExcel(id, store, delivery)).then(function (r) {
          r.file = file;
          return r;
        });
      });
    });
  }

  function readGoogleSheet(id, store, delivery) {
    return api(SHEETS + id + '?fields=sheets.properties.title').then(function (meta) {
      var names = meta.sheets.map(function (s) { return s.properties.title; });
      var tabs, banners = {};
      if (store.tabPerDay) {
        tabs = names.filter(function (n) {
          var d = phloParseDate(n, delivery, true);
          if (!d || d > delivery || d < phloAddDays(delivery, -7)) return false;
          banners[n] = 'PHLO PICK UP ON ' + phloFmt(d, 'MM/dd/yyyy');
          return true;
        });
      } else {
        tabs = phloPickTabs(names, delivery, store.tab || {});
      }
      if (!tabs.length) return { values: [], tabs: [], note: 'no tab for this month' };
      var url = SHEETS + id + '/values:batchGet?valueRenderOption=FORMATTED_VALUE&' +
        tabs.map(function (t) { return 'ranges=' + encodeURIComponent(quoteTab(t)); }).join('&');
      return api(url).then(function (r) {
        var values = [];
        (r.valueRanges || []).forEach(function (vr, i) {
          if (banners[tabs[i]]) values.push([banners[tabs[i]]]);
          values = values.concat(vr.values || []);
        });
        return { values: values, tabs: tabs };
      });
    });
  }

  function readExcel(id, store, delivery) {
    return api(DRIVE + '/' + id + '?alt=media&supportsAllDrives=true', true).then(function (buf) {
      var wb = XLSX.read(buf, { type: 'array' });
      var tabs = phloPickTabs(wb.SheetNames, delivery, store.tab || {});
      var values = [];
      tabs.forEach(function (t) {
        values = values.concat(XLSX.utils.sheet_to_json(wb.Sheets[t], { header: 1, raw: false, defval: '' }));
      });
      return { values: values, tabs: tabs, note: tabs.length ? '' : 'no tab for this month' };
    });
  }

  /* ---------------- build ---------------- */

  function build() {
    // Re-ask for sign-in straight from the click so the popup is not blocked.
    if (!state.token || Date.now() >= state.tokenExpires) { signIn(build); return; }
    var delivery = fromIso($('date').value);
    $('build').disabled = true;
    $('download').disabled = true;
    $('stores-card').hidden = false;
    var list = $('stores');
    list.textContent = '';
    var results = STORES.map(function (store) {
      var status = el('span', { class: 'status busy', text: 'reading…' });
      var meta = el('span', { class: 'meta', text: '' });
      list.appendChild(el('li', {}, [
        el('div', { class: 'row1' }, [el('span', { class: 'code', text: store.code }), status]),
        el('span', { class: 'title', text: store.title || '' }),
        meta
      ]));
      return readStore(store, delivery).then(function (r) {
        if (!r) {
          status.className = 'status warn'; status.textContent = 'no file found';
          return { store: store, rows: [], failed: true, problem: 'No sheet found in Drive' };
        }
        var rows = phloStoreRows(r.values, store, delivery);
        var past = {};
        pastDays(delivery).forEach(function (iso) { past[iso] = phloStoreRows(r.values, store, fromIso(iso)); });
        status.className = 'status ' + (rows.length ? 'ok' : 'warn');
        status.textContent = rows.length + ' row' + (rows.length === 1 ? '' : 's');
        meta.textContent = [relTime(r.file.modifiedTime), r.tabs.join(', ') || r.note].filter(Boolean).join(' · ');
        return { store: store, rows: rows, past: past, problem: rows.length ? '' : 'Nothing for this date yet' + (r.note ? ' (' + r.note + ')' : '') };
      }).catch(function (e) {
        status.className = 'status error'; status.textContent = 'error';
        meta.textContent = e.message;
        return { store: store, rows: [], failed: true, problem: 'Could not read: ' + e.message };
      });
    });

    Promise.all(results).then(function (all) {
      state.built = { delivery: delivery, stores: all };
      state.rows = [];
      all.forEach(function (r) { state.rows = state.rows.concat(r.rows); });
      savePastDays(delivery, all);
      var carried = carryOver();
      saveToday('built');
      renderTable();
      runChecks();
      renderHistory();
      $('download').disabled = !state.rows.length;
      $('build').disabled = false;
      $('compare-card').hidden = false;
      toast('Built ' + state.rows.length + ' rows for ' + niceDate(delivery) +
        (carried ? ' (' + carried + ' carried over: not confirmed delivered)' : ''));
    });
  }

  /* ---------------- table + checks ---------------- */

  function renderTable() {
    $('table-card').hidden = false;
    var tb = document.querySelector('#master tbody');
    tb.textContent = '';
    var prevCode = null;
    state.rows.forEach(function (r, i) {
      var tr = el('tr', { 'data-row': i });
      if (r[2] !== prevCode) tr.className = 'store-start';
      prevCode = r[2];
      var num = el('td', { class: 'num', text: String(i + 2) });
      if (r.carry) {
        tr.classList.add('carried');
        num.appendChild(el('span', { class: 'carry-tag', title: carryText(r.carry), text: 'from ' + shortDate(r.carry.lastIso) }));
      }
      tr.appendChild(num);
      [0, 1, 2, 3].forEach(function (c) {
        var td = el('td', { contenteditable: 'true', spellcheck: 'false', 'data-col': c, class: c === 2 ? 'code' : '' });
        td.textContent = r[c] == null ? '' : String(r[c]);
        tr.appendChild(td);
      });
      var del = el('button', { class: 'del', title: 'Delete row', 'aria-label': 'Delete row ' + (i + 2), text: '×' });
      tr.appendChild(el('td', {}, [del]));
      tb.appendChild(tr);
    });
    $('row-count').textContent = state.rows.length + ' rows';
    applyFilter();
  }

  var checkTimer;
  function runChecks() {
    var checks = phloCheckRows(state.rows);
    state.rows.forEach(function (r, i) {
      if (r.carry) checks.push({ row: i, level: r.carry.missed ? 'warn' : 'info', message: 'Carried over: ' + carryText(r.carry) });
    });
    (state.built ? state.built.stores : []).forEach(function (s) {
      if (s.problem) checks.unshift({ row: -1, level: s.rows.length ? 'info' : 'warn', message: s.store.code + ': ' + s.problem });
    });
    state.checks = checks;
    $('checks-card').hidden = false;
    $('checks-count').textContent = checks.length ? String(checks.length) : '';
    var ul = $('checks');
    ul.textContent = '';
    if (!checks.length) ul.appendChild(el('li', { class: 'empty', text: 'Nothing to check.' }));
    var marks = {};
    checks.forEach(function (c) {
      var where = c.row >= 0 ? 'Row ' + (c.row + 2) + ' · ' + (state.rows[c.row][2] || '') : 'Store';
      var li = el('li', { class: c.level, tabindex: '0' }, [el('span', { class: 'where', text: where }), el('span', { text: c.message })]);
      if (c.row >= 0) {
        li.addEventListener('click', function () { jumpTo(c.row); });
        li.addEventListener('keydown', function (e) { if (e.key === 'Enter') jumpTo(c.row); });
        if (c.level !== 'info' && marks[c.row] !== 'error') marks[c.row] = c.level;
      }
      ul.appendChild(li);
    });
    document.querySelectorAll('#master tbody tr').forEach(function (tr) {
      var i = +tr.getAttribute('data-row');
      tr.classList.toggle('error', marks[i] === 'error');
      tr.classList.toggle('warn', marks[i] === 'warn');
    });
  }

  function jumpTo(row) {
    $('filter').value = ''; applyFilter();
    var tr = document.querySelector('#master tbody tr[data-row="' + row + '"]');
    if (!tr) return;
    tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
    tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash');
  }

  function applyFilter() {
    var q = $('filter').value.trim().toUpperCase();
    document.querySelectorAll('#master tbody tr').forEach(function (tr) {
      tr.hidden = q && tr.textContent.toUpperCase().indexOf(q) < 0;
    });
  }

  function onTableInput(e) {
    var td = e.target.closest('td[data-col]');
    if (!td) return;
    var i = +td.parentNode.getAttribute('data-row');
    state.rows[i][+td.getAttribute('data-col')] = td.textContent;
    clearTimeout(checkTimer);
    checkTimer = setTimeout(runChecks, 400);
  }

  function onTableClick(e) {
    var btn = e.target.closest('.del');
    if (!btn) return;
    var i = +btn.closest('tr').getAttribute('data-row');
    var removed = state.rows.splice(i, 1)[0];
    renderTable(); runChecks();
    if (!removed.carry) saveToday('built');
    toast('Deleted ' + (removed[0] || 'row'));
  }

  /* ---------------- download ---------------- */

  function download() {
    var d = state.built.delivery;
    var data = [MASTER_HEADERS].concat(state.rows.map(function (r) {
      return r.map(function (v) { return v == null ? '' : String(v).trim(); });
    }));
    var ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 80 }, { wch: 64 }, { wch: 8 }, { wch: 72 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, phloFmt(d, 'MM.dd.yy') + '_UPLOAD.xlsx');
    saveToday('download');
    renderHistory();
  }

  /* ---------------- compare a finished file ---------------- */

  function compareFile(file) {
    if (!state.built) { toast('Build the master first, then check a file against it.'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var wb = XLSX.read(reader.result, { type: 'array' });
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' })
        .filter(function (r) { return String(r[0] || '').trim() !== ''; });
      if (rows.length && /^NAME$/i.test(String(rows[0][0]).trim())) rows.shift();
      renderCompare(file.name, rows, phloCompare(state.rows, rows));
      // The finished file is what went to Routific: remember its tickets for this date.
      if (rows.length && phloSaveDay(hist.data, isoDate(state.built.delivery), rows, 'file', new Date().toISOString())) {
        commitHistory();
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function renderCompare(name, fileRows, result) {
    var out = $('compare-out');
    out.textContent = '';
    out.appendChild(el('h2', { text: name + ' vs. store sheets for ' + niceDate(state.built.delivery) }));
    var table = el('table', { class: 'compare-summary' }, [
      el('tr', {}, ['Store', 'In sheets', 'In file', 'Missing', 'Extra'].map(function (h) { return el('th', { text: h }); }))
    ]);
    var problems = 0;
    result.stores.forEach(function (s) {
      problems += s.missing.length + s.extra.length;
      table.appendChild(el('tr', {}, [
        el('td', { text: s.code }), el('td', { text: String(s.inSources) }), el('td', { text: String(s.inFile) }),
        el('td', { class: s.missing.length ? 'bad' : 'good', text: String(s.missing.length) }),
        el('td', { class: s.extra.length ? 'bad' : 'good', text: String(s.extra.length) })
      ]));
    });
    out.appendChild(table);
    var listRows = function (title, rows) {
      if (!rows.length) return;
      out.appendChild(el('p', {}, [el('b', { text: title })]));
      out.appendChild(el('ul', { class: 'compare-list' }, rows.map(function (r) {
        return el('li', { text: r[0] + ' — ' + r[1] + ' (' + r[2] + ')' });
      })));
    };
    var missing = [], extra = [];
    result.stores.forEach(function (s) { missing = missing.concat(s.missing); extra = extra.concat(s.extra); });
    listRows('In the store sheets but missing from the file:', missing);
    listRows('In the file but not in the store sheets for this date:', extra);
    if (result.checks.length) {
      out.appendChild(el('p', {}, [el('b', { text: 'Typos and other things to check in the file:' })]));
      out.appendChild(el('ul', { class: 'compare-list' }, result.checks.map(function (c) {
        return el('li', { text: (c.row >= 0 ? 'Row ' + (c.row + 2) + ' (' + (fileRows[c.row][0] || '') + '): ' : '') + c.message });
      })));
    }
    if (!problems && !result.checks.length) out.appendChild(el('p', { class: 'good', text: 'The file matches the store sheets. Nothing to fix.' }));
  }

  /* ---------------- delivery history (tickets carried over) ---------------- */

  // Each day's master tickets and which were delivered, saved only in the user's Drive appDataFolder.
  // It has patient names and addresses, so it is never kept in the browser and only shown while signed in.
  var HISTORY_FILE = 'phlo-history.json';
  var HISTORY_KEY = 'phlo.history';
  var hist = { data: phloHistoryData(null), fileId: null, synced: false, saving: null, pending: false, timer: null, note: '', open: {} };
  var SOURCE_LABEL = { download: 'downloaded master', file: 'checked upload file', built: 'built in the app', rebuilt: 'rebuilt from the store sheets' };

  function shortDate(iso) { var p = iso.split('-'); return +p[1] + '/' + +p[2]; }
  function pastDays(delivery) { return phloLookbackDays(isoDate(delivery), PHLO_HISTORY_LOOKBACK); }

  function carryText(c) {
    var how = c.missed ? 'not delivered on ' : 'not confirmed delivered on ';
    var s = how + niceDate(fromIso(c.lastIso));
    if (c.firstIso !== c.lastIso) s += ' (on the master since ' + niceDate(fromIso(c.firstIso)) + ')';
    return s + ' - RX ' + c.rx.join(', ');
  }

  /** Older versions kept a copy of the history in this browser. Delete it from storage right away; it stays
   * in memory (never shown signed out) so it can still be merged into the Google copy if someone signs in now. */
  function purgeLocalHistory() {
    try {
      var old = localStorage.getItem(HISTORY_KEY);
      localStorage.removeItem(HISTORY_KEY);
      return old ? phloHistoryData(JSON.parse(old)) : null;
    } catch (e) { return null; /* storage blocked or bad JSON */ }
  }

  function loadHistoryFromDrive() {
    var url = DRIVE + '?spaces=appDataFolder&fields=files(id)&pageSize=1&q=' +
      encodeURIComponent("name = '" + HISTORY_FILE + "' and trashed = false");
    api(url).then(function (r) {
      hist.fileId = r.files && r.files[0] ? r.files[0].id : null;
      return hist.fileId ? api(DRIVE + '/' + hist.fileId + '?alt=media') : null;
    }).then(function (remote) {
      remote = phloHistoryData(remote);
      var merged = phloMergeHistory(hist.data, remote);
      var changed = JSON.stringify(merged.days) !== JSON.stringify(remote.days);
      hist.data = merged;
      hist.synced = !changed;
      if (changed) pushHistory();
      afterStatusChange(true);
    }).catch(function (e) {
      hist.note = 'Could not load the delivery history from Google (' + e.message + '). Try signing in again.';
      renderHistory();
    });
  }

  function pushHistory() {
    if (hist.saving) { hist.pending = true; return hist.saving; }
    var body = JSON.stringify(hist.data);
    var req;
    if (hist.fileId) {
      req = api('https://www.googleapis.com/upload/drive/v3/files/' + hist.fileId + '?uploadType=media&fields=id', false,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: body });
    } else {
      var boundary = 'phlo' + Date.now();
      var multipart = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify({ name: HISTORY_FILE, parents: ['appDataFolder'], mimeType: 'application/json' }) +
        '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + body + '\r\n--' + boundary + '--';
      req = api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', false,
        { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart });
    }
    hist.saving = req.then(function (r) {
      hist.fileId = r.id; hist.synced = true; hist.note = '';
    }).catch(function (e) {
      hist.synced = false;
      toast('Could not save the delivery history to Google: ' + e.message);
    }).then(function () {
      hist.saving = null;
      if (hist.pending) { hist.pending = false; return pushHistory(); }
      renderHistory();
    });
    return hist.saving;
  }

  function commitHistory() {
    phloPruneHistory(hist.data, isoDate(todayLocal()));
    hist.data.updatedAt = new Date().toISOString();
    hist.synced = false;
    clearTimeout(hist.timer);
    if (signedIn()) hist.timer = setTimeout(pushHistory, 800);
    renderHistory();
  }

  /** Saves the past days rebuilt from the store sheets (a saved master for that day is never replaced). */
  function savePastDays(delivery, all) {
    var now = new Date().toISOString(), changed = false;
    pastDays(delivery).forEach(function (iso) {
      var rows = [], failed = [];
      all.forEach(function (r) {
        if (r.failed) failed.push(r.store.code);
        else rows = rows.concat(r.past[iso] || []);
      });
      // A store that could not be read this time keeps the rows it had before.
      var old = hist.data.days[iso];
      if (old && old.source === 'rebuilt') old.rows.forEach(function (r) { if (failed.indexOf(r[2]) >= 0) rows.push(r); });
      if (rows.length && phloSaveDay(hist.data, iso, rows, 'rebuilt', now)) changed = true;
    });
    if (changed) commitHistory();
  }

  /** Puts every ticket not confirmed delivered on a past master into this master. Returns how many rows. */
  function carryOver() {
    if (!state.built) return 0;
    var own = state.rows.filter(function (r) { return !r.carry; });
    var items = phloOutstanding(hist.data, isoDate(state.built.delivery), own);
    var rows = own.slice();
    items.forEach(function (it) {
      var row = it.row.slice(0, 4);
      row.carry = it;
      // Right after the same store's rows, so the master stays grouped by store.
      var at = -1;
      rows.forEach(function (r, i) { if (r[2] === row[2]) at = i; });
      if (at < 0) rows.push(row); else rows.splice(at + 1, 0, row);
    });
    state.rows = rows;
    return items.length;
  }

  function saveToday(source) {
    if (!state.built || !state.rows.length) return;
    var rows = state.rows.map(function (r) { return r.slice(0, 4); });
    if (phloSaveDay(hist.data, isoDate(state.built.delivery), rows, source, new Date().toISOString())) commitHistory();
  }

  /** After a delivered/not delivered change: refresh the carried rows in the built master. */
  function afterStatusChange(quiet) {
    if (state.built) {
      carryOver();
      renderTable(); runChecks();
      saveToday('built');
      $('download').disabled = !state.rows.length;
    }
    renderHistory();
    if (!quiet) commitHistory();
  }

  function historyRefIso() { return $('date').value || isoDate(phloAddDays(todayLocal(), 1)); }

  function renderHistory() {
    var card = $('history-card');
    if (!card) return;
    card.hidden = !state.session;
    if (!state.session) return;
    var ref = historyRefIso();
    var days = hist.data.days;
    var look = phloLookbackDays(ref, PHLO_HISTORY_LOOKBACK);
    var show = Object.keys(days).filter(function (iso) {
      if (iso >= ref) return false;
      if (look.indexOf(iso) >= 0) return true;
      var c = phloDayCounts(days[iso]);
      return c.open + c.missed > 0;
    });
    look.forEach(function (iso) { if (show.indexOf(iso) < 0) show.push(iso); });
    show.sort().reverse();

    var open = phloOutstanding(hist.data, ref, state.built && isoDate(state.built.delivery) === ref ? state.rows.filter(function (r) { return !r.carry; }) : []);
    var openRx = 0; open.forEach(function (o) { openRx += o.rx.length; });
    $('history-count').textContent = openRx ? String(openRx) : '';
    var lead = $('history-lead');
    if (openRx) {
      lead.className = 'history-lead warn';
      lead.textContent = openRx + ' ticket' + (openRx === 1 ? ' is' : 's are') + ' on an earlier master and not confirmed delivered. ' +
        (state.built ? 'They are in this master (marked "from …").' : 'Build the master and they are added to it.') +
        ' Drop the Routific export for each day, or tick what was delivered, to take them off.';
    } else {
      lead.className = 'history-lead ok';
      lead.textContent = Object.keys(days).length ? 'Every ticket on the earlier masters is confirmed delivered or already on this master.' :
        'No earlier masters saved yet. Build the master and the past ' + PHLO_HISTORY_LOOKBACK + ' delivery days are rebuilt from the store sheets and saved here.';
    }
    var sync = hist.note || (signedIn() ? (hist.saving ? 'Saving…' : hist.synced ? 'Saved to your Google account.' : 'Not saved to Google yet.') :
      'Sign in again to save it to your Google account.');
    $('history-sync').textContent = sync;

    var ul = $('history');
    ul.textContent = '';
    show.forEach(function (iso) { ul.appendChild(historyDayItem(iso, days[iso])); });
  }

  function historyDayItem(iso, day) {
    var head = el('div', { class: 'hday-head' }, [el('b', { text: niceDate(fromIso(iso)) })]);
    if (!day || !day.rows.length) {
      var built = state.built && pastDays(state.built.delivery).indexOf(iso) >= 0;
      head.appendChild(el('span', { class: 'muted small', text: built ? 'no tickets for this day in the store sheets' :
        'no master saved yet - build the master to rebuild it from the store sheets' }));
      var li0 = el('li', { class: 'hday' }, [head]);
      if (day && day.routific) li0.appendChild(routificLine(iso, day));
      return li0;
    }
    var c = phloDayCounts(day);
    head.appendChild(el('span', { class: 'muted small', text: c.total + ' ticket' + (c.total === 1 ? '' : 's') + ' · ' + SOURCE_LABEL[day.source] }));
    var pills = el('div', { class: 'hday-pills' }, [
      el('span', { class: 'hp ok', text: c.delivered + ' delivered' }),
      c.missed ? el('span', { class: 'hp bad', text: c.missed + ' not delivered' }) : null,
      c.open ? el('span', { class: 'hp open', text: c.open + ' not confirmed' }) : null
    ]);
    var all = el('button', { class: 'btn small-btn', type: 'button', text: 'Mark the rest delivered' });
    all.disabled = !c.open;
    all.addEventListener('click', function () {
      if (!confirm('Mark the ' + c.open + ' unconfirmed ticket' + (c.open === 1 ? '' : 's') + ' on ' + niceDate(fromIso(iso)) + ' as delivered?' +
        (c.missed ? ' (The ' + c.missed + ' not delivered stay not delivered.)' : ''))) return;
      phloMarkRx(hist.data, iso, phloDayRx(day).filter(function (n) { return !day.status[n]; }), 'delivered');
      afterStatusChange();
    });
    var li = el('li', { class: 'hday' }, [el('div', { class: 'hday-top' }, [head, pills, all])]);
    if (day.routific) li.appendChild(routificLine(iso, day));

    // Ticket list: open and not delivered first.
    var rank = function (r) {
      var rx = phloRxNumbers(r[0]);
      if (rx.some(function (n) { return day.status[n] === 'missed'; })) return 0;
      if (rx.some(function (n) { return !day.status[n]; })) return 1;
      return 2;
    };
    var rows = day.rows.slice().sort(function (a, b) { return rank(a) - rank(b); });
    var det = el('details', { class: 'hday-list' }, [el('summary', { text: 'Tickets (' + day.rows.length + ')' })]);
    var fill = function () {
      if (det.querySelector('ul')) return;
      var list = el('ul', {});
      rows.forEach(function (r) {
        var rx = phloRxNumbers(r[0]);
        if (!rx.length) return;
        var st = rx.every(function (n) { return day.status[n] === 'delivered'; }) ? 'delivered' :
          rx.some(function (n) { return day.status[n] === 'missed'; }) ? 'missed' : 'open';
        var box = el('input', { type: 'checkbox', 'aria-label': 'Delivered: ' + r[0] });
        box.checked = st === 'delivered';
        box.addEventListener('change', function () {
          phloMarkRx(hist.data, iso, rx, box.checked ? 'delivered' : null);
          afterStatusChange();
        });
        list.appendChild(el('li', { class: st }, [
          el('label', {}, [box, el('span', { class: 'tname', text: r[0] }), el('span', { class: 'muted', text: ' · ' + r[2] })]),
          st === 'missed' ? el('span', { class: 'hp bad', text: 'not delivered' }) : st === 'open' ? el('span', { class: 'hp open', text: 'not confirmed' }) : null
        ]));
      });
      det.appendChild(list);
    };
    // Stays open while ticking boxes (the panel is redrawn after each change).
    if (hist.open[iso]) { det.open = true; fill(); }
    det.addEventListener('toggle', function () {
      if (det.open) { hist.open[iso] = true; fill(); } else delete hist.open[iso];
    });
    li.appendChild(det);
    return li;
  }

  function routificLine(iso, day) {
    var r = day.routific, parts = [];
    var drivers = (r.drivers || []).map(function (d) { return d.name + ' ' + d.stops; }).join(', ');
    parts.push('Routific (' + r.file + '): ' + r.routed + ' stop' + (r.routed === 1 ? '' : 's') + ' routed' + (drivers ? ' (' + drivers + ')' : '') +
      (r.unscheduled ? ', ' + r.unscheduled + ' unscheduled' : ', none unscheduled') + '.');
    var level = 'info';
    if (r.kind === 'summary') {
      var stops = day.rows.length;
      if (stops) {
        var total = r.routed + r.unscheduled;
        parts.push('The master had ' + stops + ' stop' + (stops === 1 ? '' : 's') + (total !== stops ? ' but Routific had ' + total + ' - check for missing or added stops.' : ', same as Routific.'));
        if (total !== stops) level = 'warn';
      }
      if (r.unscheduled) { parts.push(r.unscheduled + ' stop' + (r.unscheduled === 1 ? ' was' : 's were') + ' not on any route, so not delivered.'); level = 'warn'; }
      parts.push('A summary has no ticket numbers, so it cannot say which tickets were delivered: export the stops from Routific (or tick them below).');
    } else if (!r.hasStatus) {
      parts.push('No delivery status in this file, so routed stops count as delivered and unscheduled ones as not delivered.');
    }
    return el('p', { class: 'hday-routific ' + level, text: parts.join(' ') });
  }

  function readRoutificFiles(files) {
    Array.prototype.forEach.call(files || [], function (file) {
      var reader = new FileReader();
      reader.onload = function () {
        var rows;
        try {
          var wb = XLSX.read(reader.result, { type: 'array', raw: true });
          rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
        } catch (e) { toast('Could not read ' + file.name); return; }
        var parsed = phloParseRoutific(rows);
        if (parsed.kind === 'unknown') { toast(file.name + ' does not look like a Routific export (no stop counts or RX numbers).'); return; }
        var ref = fromIso(historyRefIso());
        var iso = phloDateFromFileName(file.name, ref);
        if (!iso) {
          iso = prompt('Which delivery date is ' + file.name + ' for? (YYYY-MM-DD)', phloLookbackDays(historyRefIso(), 1)[0]);
          if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso.trim())) return;
          iso = iso.trim();
        }
        var day = hist.data.days[iso] || (hist.data.days[iso] = phloHistoryDay({ rows: [], source: 'rebuilt' }));
        day.routific = {
          kind: parsed.kind, file: file.name, at: new Date().toISOString(), routed: parsed.routed,
          unscheduled: parsed.unscheduled, drivers: parsed.drivers, hasStatus: parsed.hasStatus,
          stops: parsed.kind === 'stops' ? parsed.stops : null
        };
        var msg = niceDate(fromIso(iso)) + ': ';
        if (parsed.kind === 'stops') {
          var res = phloApplyRoutific(hist.data, iso, parsed);
          msg += day.rows.length ? res.delivered + ' delivered, ' + res.missed + ' not delivered' +
            (res.notOnMaster.length ? ', ' + res.notOnMaster.length + ' not on the saved master' : '') :
            'saved; it is applied once that day\'s master is rebuilt (build the master)';
        } else {
          msg += 'route summary saved (stop counts only, no ticket numbers)';
        }
        toast(msg);
        afterStatusChange();
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ---------------- driver profiles ---------------- */

  // Saved as one JSON file in the user's Drive appDataFolder (private to this app, not visible in
  // Drive's file list), with a copy in this browser so the list shows before signing in.
  var DRIVERS_FILE = 'phlo-drivers.json';
  var LOCAL_KEY = 'phlo.drivers';
  var drv = { data: phloDriversData(null), fileId: null, synced: false, saving: null, pending: false, editing: null };

  function loadLocalDrivers() {
    try { drv.data = phloDriversData(JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null')); } catch (e) { /* storage blocked or bad JSON */ }
  }
  function saveLocalDrivers() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(drv.data)); } catch (e) { /* storage blocked */ }
  }

  function findDriversFile() {
    var url = DRIVE + '?spaces=appDataFolder&fields=files(id,modifiedTime)&pageSize=1&q=' +
      encodeURIComponent("name = '" + DRIVERS_FILE + "' and trashed = false");
    return api(url).then(function (r) { return r.files && r.files[0] ? r.files[0].id : null; });
  }

  function loadDriversFromDrive() {
    drv.synced = false; renderSyncNote('Loading drivers from your Google account…');
    findDriversFile().then(function (id) {
      drv.fileId = id;
      return id ? api(DRIVE + '/' + id + '?alt=media') : null;
    }).then(function (remote) {
      var local = drv.data;
      remote = remote ? phloDriversData(remote) : null;
      // Keep whichever copy was changed last; push the local one up if it is newer.
      if (remote && (remote.updatedAt || '') >= (local.updatedAt || '')) {
        drv.data = remote; saveLocalDrivers(); drv.synced = true;
      } else if (local.drivers.length || remote) {
        return pushDrivers();
      } else {
        drv.synced = true;
      }
    }).then(function () {
      renderDrivers();
    }).catch(function (e) {
      renderSyncNote('Could not load drivers from Google (' + e.message + '). Changes are kept on this device for now.');
    });
  }

  function pushDrivers() {
    // One save at a time; if more edits arrive meanwhile, save again once it finishes.
    if (drv.saving) { drv.pending = true; return drv.saving; }
    var body = JSON.stringify(drv.data);
    var req;
    if (drv.fileId) {
      req = api('https://www.googleapis.com/upload/drive/v3/files/' + drv.fileId + '?uploadType=media&fields=id', false,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: body });
    } else {
      var boundary = 'phlo' + Date.now();
      var multipart = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify({ name: DRIVERS_FILE, parents: ['appDataFolder'], mimeType: 'application/json' }) +
        '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + body + '\r\n--' + boundary + '--';
      req = api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', false,
        { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: multipart });
    }
    renderSyncNote('Saving…');
    drv.saving = req.then(function (r) {
      drv.fileId = r.id; drv.synced = true;
    }).catch(function (e) {
      drv.synced = false;
      toast('Could not save drivers to Google: ' + e.message);
    }).then(function () {
      drv.saving = null;
      if (drv.pending) { drv.pending = false; return pushDrivers(); }
      renderSyncNote();
    });
    return drv.saving;
  }

  function signedIn() { return !!state.token && Date.now() < state.tokenExpires; }

  function commitDrivers() {
    // Only keep the last 60 days of "who's working" picks.
    var cutoff = isoDate(phloAddDays(todayLocal(), -60));
    Object.keys(drv.data.roster).forEach(function (k) { if (k < cutoff) delete drv.data.roster[k]; });
    drv.data.updatedAt = new Date().toISOString();
    saveLocalDrivers();
    drv.synced = false;
    renderDrivers();
    if (signedIn()) pushDrivers();
  }

  function renderSyncNote(msg) {
    var note = $('sync-note');
    if (msg) { note.textContent = msg; return; }
    if (drv.saving) note.textContent = 'Saving…';
    else if (drv.synced && signedIn()) note.textContent = 'Saved to your Google account' + ($('who').textContent ? ' (' + $('who').textContent + ')' : '') + '. Sign in on any computer to see these drivers.';
    else note.textContent = 'Saved on this device only. Sign in with Google to keep drivers in your Google account.';
  }

  function rosterIso() { return $('roster-date').value || isoDate(phloAddDays(todayLocal(), 1)); }

  function renderDrivers() {
    var data = drv.data, iso = rosterIso();
    var working = phloRosterFor(data, iso);
    var ul = $('drivers');
    ul.textContent = '';
    var sorted = data.drivers.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (!sorted.length) ul.appendChild(el('li', { class: 'empty', text: 'No drivers yet. Click "Add driver" to create the first profile.' }));
    sorted.forEach(function (d) {
      var on = working.indexOf(d.id) >= 0;
      var box = el('input', { type: 'checkbox', 'aria-label': d.name + ' is working' });
      box.checked = on;
      box.addEventListener('change', function () { toggleWorking(d.id, box.checked); });
      var name = el('button', { class: 'dname', type: 'button', text: d.name });
      name.addEventListener('click', function () { openDriverForm(d); });
      var addrLine = el('div', { class: 'dmeta' });
      var addAddr = function (address, pin) {
        addrLine.appendChild(el('b', { text: address }));
        addrLine.appendChild(document.createTextNode(' '));
        addrLine.appendChild(el('a', { class: 'maplink', href: phloMapsUrl(address, pin), target: '_blank', rel: 'noopener',
          title: pin ? 'Open the pinned spot in Google Maps' : 'Search Google Maps for this address (not pinned yet)',
          text: pin ? 'Map' : 'Map (not pinned)' }));
      };
      addAddr(d.startAddress, d.startPin);
      if (d.endAddress && d.endAddress !== d.startAddress) { addrLine.appendChild(document.createTextNode(' → ')); addAddr(d.endAddress, d.endPin); }
      var meta2 = [];
      var part2 = function (label, value) { if (value) meta2.push(el('span', {}, [label + ' ', el('b', { text: value })])); };
      part2('Hours', d.availableFrom && d.availableTo ? d.availableFrom + '–' + d.availableTo
        : d.availableFrom ? 'from ' + d.availableFrom : d.availableTo ? 'until ' + d.availableTo : '');
      part2('Lunch', d.lunchFrom && d.lunchTo ? d.lunchFrom + '–' + d.lunchTo : '');
      part2('Capacity', d.capacity === '' ? '' : String(d.capacity));
      part2('Speed', d.speed !== 'NORMAL' ? d.speed : '');
      part2('Mobile', d.mobile);
      var line2 = el('div', { class: 'dmeta' });
      meta2.forEach(function (n, i) { if (i) line2.appendChild(document.createTextNode(' · ')); line2.appendChild(n); });
      var chips = el('div', { class: 'chips' }, d.types.map(function (t) { return el('span', { class: 'chip', text: t }); }));
      var del = el('button', { class: 'del', type: 'button', title: 'Delete driver', 'aria-label': 'Delete ' + d.name, text: '×' });
      del.addEventListener('click', function () { deleteDriver(d); });
      ul.appendChild(el('li', { class: on ? '' : 'off' }, [
        box,
        el('div', { class: 'who' }, [name, addrLine, meta2.length ? line2 : null, chips]),
        del
      ]));
    });
    var label = working.length + ' of ' + data.drivers.length + ' working ' + niceDate(fromIso(iso));
    $('roster-count').textContent = data.drivers.length ? label : '';
    $('drivers-tab-count').textContent = data.drivers.length ? String(data.drivers.length) : '';
    $('download-drivers').disabled = !working.length;
    renderSyncNote();
  }

  function toggleWorking(id, on) {
    var iso = rosterIso();
    var list = phloRosterFor(drv.data, iso).filter(function (x) { return x !== id; });
    if (on) list.push(id);
    drv.data.roster[iso] = list;
    commitDrivers();
  }

  function deleteDriver(d) {
    if (!confirm('Delete the driver profile for ' + d.name + '?')) return;
    drv.data.drivers = drv.data.drivers.filter(function (x) { return x.id !== d.id; });
    Object.keys(drv.data.roster).forEach(function (k) {
      drv.data.roster[k] = drv.data.roster[k].filter(function (x) { return x !== d.id; });
    });
    if (drv.editing && drv.editing.id === d.id) closeDriverForm();
    commitDrivers();
    toast('Deleted ' + d.name);
  }

  // Map pins for the two address fields while the form is open: {startAddress: pin|null, endAddress: pin|null}.
  var formPins = { startAddress: null, endAddress: null };
  var PIN_KEYS = { startAddress: 'startPin', endAddress: 'endPin' };

  /** The pin for an address field, if it still matches what's typed. */
  function currentPin(field) {
    return phloNormalizePin(formPins[field], phloCleanText($('driver-form').elements[field].value));
  }

  function renderPinNote(field) {
    var note = $(field + '-pin');
    var address = phloCleanText($('driver-form').elements[field].value);
    var pin = currentPin(field);
    note.textContent = '';
    note.className = 'pin-note' + (pin ? ' ok' : '');
    if (!address) return;
    if (pin) {
      note.appendChild(document.createTextNode('Pinned on Google Maps · '));
    } else if (phloMaps.enabled) {
      note.appendChild(document.createTextNode('Not pinned yet: pick the address from the Google suggestions · '));
    } else {
      return;
    }
    note.appendChild(el('a', { href: phloMapsUrl(address, pin), target: '_blank', rel: 'noopener', text: 'Open in Google Maps' }));
  }

  var FORM_FIELDS = ['name', 'startAddress', 'endAddress', 'availableFrom', 'availableTo', 'mobile', 'capacity', 'types', 'lunchFrom', 'lunchTo'];

  function openDriverForm(d) {
    var f = $('driver-form');
    drv.editing = d || null;
    f.reset();
    FORM_FIELDS.forEach(function (k) {
      var v = d ? d[k] : '';
      f.elements[k].value = Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v));
      f.elements[k].removeAttribute('aria-invalid');
    });
    Object.keys(PIN_KEYS).forEach(function (k) { formPins[k] = d ? d[PIN_KEYS[k]] : null; renderPinNote(k); });
    var speed = d ? d.speed : 'NORMAL';
    Array.prototype.forEach.call(f.elements.speed, function (r) { r.checked = r.value === speed; });
    $('driver-form-title').textContent = d ? 'Edit ' + d.name : 'Add driver';
    $('driver-errors').hidden = true;
    renderTypesPreview();
    $('driver-form-card').hidden = false;
    $('driver-form-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
    f.elements.name.focus({ preventScroll: true });
  }

  function closeDriverForm() {
    drv.editing = null;
    $('driver-form-card').hidden = true;
  }

  function renderTypesPreview() {
    var types = phloParseTypes($('driver-form').elements.types.value);
    var box = $('types-preview');
    box.textContent = '';
    types.forEach(function (t) { box.appendChild(el('span', { class: 'chip', text: t })); });
  }

  function saveDriverForm(e) {
    e.preventDefault();
    var f = $('driver-form');
    var raw = { id: drv.editing ? drv.editing.id : null };
    FORM_FIELDS.forEach(function (k) { raw[k] = f.elements[k].value; });
    Object.keys(PIN_KEYS).forEach(function (k) { raw[PIN_KEYS[k]] = formPins[k]; });
    var checked = f.querySelector('input[name="speed"]:checked');
    raw.speed = checked ? checked.value : 'NORMAL';
    var d = phloNormalizeDriver(raw);
    var errs = phloValidateDriver(d, drv.data.drivers);
    FORM_FIELDS.forEach(function (k) { f.elements[k].removeAttribute('aria-invalid'); });
    var box = $('driver-errors');
    if (errs.length) {
      box.textContent = '';
      errs.forEach(function (x) {
        box.appendChild(el('li', { text: x.message }));
        if (f.elements[x.field]) f.elements[x.field].setAttribute('aria-invalid', 'true');
      });
      box.hidden = false;
      var first = f.elements[errs[0].field];
      if (first && first.focus) first.focus();
      return;
    }
    var isNew = !drv.editing;
    if (isNew) {
      drv.data.drivers.push(d);
      // A new driver works on the date being viewed.
      var iso = rosterIso();
      var list = phloRosterFor(drv.data, iso);
      if (list.indexOf(d.id) < 0) list.push(d.id);
      drv.data.roster[iso] = list;
    } else {
      drv.data.drivers = drv.data.drivers.map(function (x) { return x.id === d.id ? d : x; });
    }
    closeDriverForm();
    commitDrivers();
    toast((isNew ? 'Added ' : 'Saved ') + d.name);
  }

  function downloadDrivers() {
    var iso = rosterIso();
    var working = phloRosterFor(drv.data, iso);
    var list = drv.data.drivers.filter(function (d) { return working.indexOf(d.id) >= 0; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    var ws = XLSX.utils.aoa_to_sheet(phloDriverRows(list));
    ws['!cols'] = [{ wch: 22 }, { wch: 44 }, { wch: 44 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 9 }, { wch: 20 }, { wch: 14 }, { wch: 10 }, { wch: 10 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Drivers');
    XLSX.writeFile(wb, phloFmt(fromIso(iso), 'MM.dd.yy') + '_DRIVERS.xlsx');
  }

  // Nothing is shown until an allowed account signs in.
  function showView(name) {
    state.view = name;
    if (!state.session) { $('view-master').hidden = $('view-drivers').hidden = true; return; }
    document.querySelectorAll('.tab').forEach(function (t) {
      if (t.getAttribute('data-view') === name) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    $('view-master').hidden = name !== 'master';
    $('view-drivers').hidden = name !== 'drivers';
    try { localStorage.setItem('phlo.view', name); } catch (e) { /* storage blocked */ }
  }

  /* ---------------- wire up ---------------- */

  function updateWindowNote() {
    if (!$('date').value) return;
    var d = fromIso($('date').value);
    var picks = phloPickupDates(d).map(niceDate).join(' + ');
    $('window-note').textContent = 'Uses rows entered ' + picks + ', plus any row whose notes say it must be delivered ' + niceDate(d) + '.';
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('date').value = isoDate(phloAddDays(todayLocal(), 1));
    updateWindowNote();
    $('date').addEventListener('change', updateWindowNote);
    $('signin').addEventListener('click', function () { signIn(); });
    $('signin-main').addEventListener('click', function () { signIn(); });
    $('signout').addEventListener('click', signOut);
    $('build').addEventListener('click', build);
    $('download').addEventListener('click', download);
    $('filter').addEventListener('input', applyFilter);
    var tb = document.querySelector('#master tbody');
    tb.addEventListener('input', onTableInput);
    tb.addEventListener('click', onTableClick);
    $('save-client').addEventListener('click', function () {
      var v = $('client-id').value.trim();
      if (!/apps\.googleusercontent\.com$/.test(v)) { toast('That does not look like an OAuth client ID.'); return; }
      try { localStorage.setItem('phlo.clientId', v); } catch (e) { toast('Could not save in this browser; put it in config.js instead.'); }
      CFG.clientId = CFG.clientId || v;
      initAuth();
      toast('Saved. Now sign in.');
    });
    $('compare-file').addEventListener('change', function (e) { if (e.target.files[0]) compareFile(e.target.files[0]); e.target.value = ''; });
    var drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer.files[0]) compareFile(e.dataTransfer.files[0]); });

    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { showView(t.getAttribute('data-view')); });
    });
    var view = 'master';
    try { view = localStorage.getItem('phlo.view') === 'drivers' ? 'drivers' : 'master'; } catch (e) { /* storage blocked */ }
    showView(view);
    $('roster-date').value = isoDate(phloAddDays(todayLocal(), 1));
    $('roster-date').addEventListener('change', renderDrivers);
    $('add-driver').addEventListener('click', function () { openDriverForm(null); });
    $('cancel-driver').addEventListener('click', closeDriverForm);
    $('driver-form').addEventListener('submit', saveDriverForm);
    $('driver-form').elements.types.addEventListener('input', renderTypesPreview);
    phloMaps.onError = toast;
    Object.keys(PIN_KEYS).forEach(function (k) {
      var input = $('driver-form').elements[k];
      input.addEventListener('input', function () { renderPinNote(k); });
      phloMaps.attach(input, function (pin) { formPins[k] = pin; renderPinNote(k); });
    });
    $('download-drivers').addEventListener('click', downloadDrivers);
    loadLocalDrivers();
    renderDrivers();
    var old = purgeLocalHistory();
    if (old) hist.data = old;
    renderHistory();
    $('date').addEventListener('change', renderHistory);
    $('routific-file').addEventListener('change', function (e) { readRoutificFiles(e.target.files); e.target.value = ''; });
    var rdrop = $('routific-drop');
    ['dragenter', 'dragover'].forEach(function (t) { rdrop.addEventListener(t, function (e) { e.preventDefault(); rdrop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { rdrop.addEventListener(t, function () { rdrop.classList.remove('over'); }); });
    rdrop.addEventListener('drop', function (e) { e.preventDefault(); readRoutificFiles(e.dataTransfer.files); });
    initAuth();
  });
})();
