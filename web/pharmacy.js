/* PHLO pharmacy page: a pharmacy signs in with its store code + PIN (set by the office under Dispatch >
 * Texting settings) and sees its own deliveries for a day: driver, arrival time, outcome, what the patient
 * answered by text. It approves or declines "leave it at the door / in the mailbox" requests (with the name
 * and position of the staff member) and can ask a driver to bring a stop back ("Please RTS to RX").
 * Talks only to the dispatch server. The sign-in is remembered in this browser; patient data is not. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'phlo.rx';
  var me = null, data = null, timer = null;

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k]; else if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.hidden = true; }, 4000);
  }
  function hhmm(iso) { return iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''; }
  function niceDate(iso) {
    var p = iso.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
  }

  function saved() {
    try { var s = JSON.parse(localStorage.getItem(KEY) || 'null'); return s && s.session && s.expires > Date.now() ? s : null; } catch (e) { return null; }
  }

  function login(e) {
    e.preventDefault();
    var f = $('rx-login'), err = $('rx-login-error');
    var store = f.elements.store.value.trim(), pin = f.elements.pin.value.trim();
    err.hidden = true;
    if (!store || !pin) { err.textContent = 'Type your store code and PIN.'; err.hidden = false; return; }
    var btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    phloBackend.call('rx.login', { store: store, pin: pin }).then(function (r) {
      me = { session: r.session, name: r.name, expires: r.expires };
      try { localStorage.setItem(KEY, JSON.stringify(me)); } catch (x) { /* storage blocked: signed in for this visit */ }
      f.reset();
      enter();
    }).catch(function (x) { err.textContent = x.message; err.hidden = false; })
      .then(function () { btn.disabled = false; });
  }

  function logout(silent) {
    if (me && !silent) phloBackend.call('rx.logout', { session: me.session }).catch(function () {});
    me = null; data = null;
    try { localStorage.removeItem(KEY); } catch (x) { /* storage blocked */ }
    clearInterval(timer);
    document.body.classList.remove('rx-mode');
    $('view-rx').hidden = true;
    $('driver-signout').hidden = true;
    $('who').textContent = '';
    $('rx-stops').textContent = '';
  }

  function authFailed(msg) {
    logout(true);
    var err = $('rx-login-error');
    err.textContent = msg || 'Please sign in again.'; err.hidden = false;
  }

  function enter() {
    document.body.classList.add('rx-mode');
    $('view-rx').hidden = false;
    $('driver-signout').hidden = false;
    $('who').textContent = 'Pharmacy ' + me.name;
    $('rx-title').textContent = 'Pharmacy ' + me.name;
    load();
    clearInterval(timer);
    timer = setInterval(function () { if (!document.hidden && !document.querySelector('dialog[open]')) load(); }, 60000);
  }

  function load() {
    if (!me) return;
    phloBackend.call('rx.day', { session: me.session, date: $('rx-date').value || '' }).then(function (r) {
      data = r;
      if (!$('rx-date').value) $('rx-date').value = r.date;
      render();
    }).catch(function (e) {
      if (e.auth) authFailed(e.message); else $('rx-sub').textContent = e.message;
    });
  }

  function render() {
    var list = $('rx-stops');
    list.textContent = '';
    var done = data.stops.filter(function (s) { return s.update; }).length;
    var asks = data.stops.filter(function (s) { return s.approval && s.approval.status === 'pending' && !s.update; }).length;
    $('rx-sub').textContent = niceDate(data.date) + ' · updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ' (refreshes every minute)';
    $('rx-count').textContent = done + ' of ' + data.stops.length + ' done' + (asks ? ' · ' + asks + ' need your OK' : '');
    if (!data.stops.length) { list.appendChild(el('li', { class: 'dv-empty', text: 'No deliveries for your pharmacy were sent to drivers for this day.' })); return; }
    data.stops.forEach(function (s) {
      var what = el('span', { class: 'what' }, [el('b', { text: s.name }), ' ' + s.address, el('br'),
        el('span', { class: 'muted', text: s.driverName + (s.eta ? ' · ETA ' + phloClock(s.eta) : '') })]);
      var chips = el('span', { class: 'chips' });
      var u = s.update;
      if (u) {
        var how = (u.methods || []).map(function (m) { return { mailbox: 'mailbox', door: 'front door', approved: 'approved' }[m]; }).join(', ');
        chips.appendChild(el('span', { class: 'chip ' + (u.status === 'delivered' ? 'ok' : 'bad'),
          text: (u.status === 'delivered' ? 'Delivered' : 'Not delivered') + (how ? ' · ' + how : '') + (u.approvedBy ? ' by ' + u.approvedBy : '') + ' · ' + hhmm(u.at) }));
        if (u.note) chips.appendChild(el('span', { class: 'chip', text: '“' + u.note + '”' }));
      }
      if (s.texted) chips.appendChild(el('span', { class: 'chip', text: 'Patient texted ' + hhmm(s.texted) }));
      else if (!s.hasPhone && !u) chips.appendChild(el('span', { class: 'chip muted-chip', text: 'No mobile number' }));
      if (s.request) chips.appendChild(el('span', { class: 'chip warn', text: 'Patient: ' + phloRequestText(s.request) }));
      if (s.approval) {
        var a = s.approval;
        chips.appendChild(el('span', { class: 'chip ' + (a.status === 'approved' ? 'ok' : 'bad'),
          text: a.status === 'approved' ? 'OK\'d by ' + a.by + ', ' + a.position : a.status === 'declined' ? 'Declined' : 'Needs your OK' }));
      }
      s.msgs.forEach(function (m) { chips.appendChild(el('span', { class: 'chip', text: 'To driver: ' + m.text + ' · ' + (m.readAt ? 'read' : 'not read yet') })); });
      if (chips.childNodes.length) { what.appendChild(el('br')); what.appendChild(chips); }
      var right = el('span', {});
      var btn = function (text, fn, cls) { var b = el('button', { type: 'button', class: cls || 'linkish', text: text }); b.addEventListener('click', fn); right.appendChild(b); };
      if (s.approval && s.approval.status === 'pending' && !u) btn('Approve / decline', function () { approve(s); }, 'btn primary');
      if (!u) btn('Return to pharmacy', function () { message(s); });
      if (u && u.photo) btn('Photo', function () { file(s, 'photo'); });
      if (u && u.signature) btn('Signature', function () { file(s, 'signature'); });
      list.appendChild(el('li', {}, [el('span', { class: 'seq', text: String(s.seq) }), what, right]));
    });
  }

  function approve(s) {
    phloAsk.approval({ title: s.name, request: phloRequestText(s.request),
      note: 'Approving lets the driver leave it with no signature; the driver must take a photo. The patient and driver are told right away.' }, function (ans) {
      return phloBackend.call('rx.approve', { session: me.session, date: data.date, stopId: s.id, ok: ans.ok, by: ans.by, position: ans.position }).then(function () {
        toast(ans.ok ? 'Approved. The patient and driver were told.' : 'Declined. The patient and driver were told.');
        load();
      }, function (e) { if (e.auth) authFailed(e.message); throw e; });
    });
  }

  function message(s) {
    phloAsk.message({ title: s.name, seq: s.seq, askName: true }, function (ans) {
      return phloBackend.call('rx.message', { session: me.session, date: data.date, stopId: s.id, reason: ans.reason, other: ans.other, by: ans.by }).then(function (r) {
        toast(r.msg.texted ? 'Sent to the driver.' : 'Sent to the driver app.');
        load();
      }, function (e) { if (e.auth) authFailed(e.message); throw e; });
    });
  }

  function file(s, which) {
    $('img-title').textContent = (which === 'photo' ? 'Photo' : 'Signature') + ' · ' + s.name;
    $('img-full').removeAttribute('src');
    $('img-dialog').showModal();
    phloBackend.call('rx.file', { session: me.session, date: data.date, stopId: s.id, which: which }).then(function (r) {
      $('img-full').src = r.dataUrl;
    }).catch(function (e) { $('img-dialog').close(); toast('Could not open it: ' + e.message); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!phloBackend.enabled || /^#t=/.test(location.hash)) return;
    $('rx-login').hidden = false;
    $('rx-login').addEventListener('submit', login);
    $('driver-signout').addEventListener('click', function () { if (me) logout(false); });
    $('rx-refresh').addEventListener('click', load);
    $('rx-date').addEventListener('change', load);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && me && !document.querySelector('dialog[open]')) load(); });
    me = saved();
    if (me) enter();
  });
})();
