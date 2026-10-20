/* PHLO master web app: reads the store sheets with the signed-in Google account,
 * builds the master with core.js, shows checks, and downloads the upload .xlsx.
 * Nothing is sent anywhere except Google's own APIs. */
(function () {
  'use strict';

  var CFG = window.PHLO_CONFIG || {};
  var TZ = CFG.timeZone || 'America/Los_Angeles';
  var SCOPES = 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly';
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
        if (state.onToken) { var f = state.onToken; state.onToken = null; f(); }
        afterSignIn();
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

  function afterSignIn() {
    $('signin').hidden = true;
    $('signout').hidden = false;
    $('build').disabled = false;
    api('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)').then(function (r) {
      $('who').textContent = r.user && r.user.emailAddress || '';
    }).catch(function () { /* not important */ });
  }

  function signOut() {
    if (state.token && google.accounts.oauth2.revoke) google.accounts.oauth2.revoke(state.token, function () {});
    state.token = null;
    $('signin').hidden = false; $('signout').hidden = true; $('build').disabled = true; $('who').textContent = '';
  }

  function withToken() {
    if (state.token && Date.now() < state.tokenExpires) return Promise.resolve();
    return new Promise(function (resolve) { signIn(resolve); });
  }

  function api(url, asBuffer) {
    return withToken().then(function () {
      return fetch(url, { headers: { Authorization: 'Bearer ' + state.token } });
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
          return { store: store, rows: [], problem: 'No sheet found in Drive' };
        }
        var rows = phloStoreRows(r.values, store, delivery);
        status.className = 'status ' + (rows.length ? 'ok' : 'warn');
        status.textContent = rows.length + ' row' + (rows.length === 1 ? '' : 's');
        meta.textContent = [relTime(r.file.modifiedTime), r.tabs.join(', ') || r.note].filter(Boolean).join(' · ');
        return { store: store, rows: rows, problem: rows.length ? '' : 'Nothing for this date yet' + (r.note ? ' (' + r.note + ')' : '') };
      }).catch(function (e) {
        status.className = 'status error'; status.textContent = 'error';
        meta.textContent = e.message;
        return { store: store, rows: [], problem: 'Could not read: ' + e.message };
      });
    });

    Promise.all(results).then(function (all) {
      state.built = { delivery: delivery, stores: all };
      state.rows = [];
      all.forEach(function (r) { state.rows = state.rows.concat(r.rows); });
      renderTable();
      runChecks();
      $('download').disabled = !state.rows.length;
      $('build').disabled = false;
      $('compare-card').hidden = false;
      toast('Built ' + state.rows.length + ' rows for ' + niceDate(delivery));
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
      tr.appendChild(el('td', { class: 'num', text: String(i + 2) }));
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
    initAuth();
  });
})();
