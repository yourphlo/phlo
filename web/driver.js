/* PHLO driver app: a driver signs in with their name + PIN and sees only their own route.
 * At each stop they record the outcome, how it was left, copay collected, a photo and a signature.
 * They also see what each patient answered to the "driver is on the way" text (not home, someone else will
 * receive it, leave it at the door once the pharmacy OKs it...) and messages from the office or a pharmacy
 * ("Please RTS to RX ..."). Tapping Navigate tells the server they're on the way, which starts the patient texts.
 * Talks only to the dispatch server (backend.js). The route is kept in memory only; the browser
 * just remembers the sign-in. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'phlo.driver';
  var me = null;     // {session, name, expires}
  var data = null;   // {date, today, route, updates}
  var editing = null; // stop being recorded
  var photo = null;  // new photo (data URL) for the open stop
  var sig = { ctx: null, ink: false, drawing: false };
  var refreshTimer = null;
  var startedFor = null; // the date we told the server the driver started

  /** What the patient answered for a stop, and the pharmacy's OK: {request, approval, texted} or null. */
  function patientOf(s) { return data && data.texts && data.texts[s.id] || null; }

  /** The pharmacy OK'd leaving this stop without a signature. */
  function leaveOk(s) {
    var p = patientOf(s);
    return !!(p && p.request && phloNeedsApproval(p.request.choice) && p.approval && p.approval.status === 'approved');
  }

  /** A chip for the patient's answer: [text, class]. */
  function patientChip(p) {
    if (!p || !p.request) return null;
    var t = 'Patient: ' + phloRequestText(p.request), cls = 'warn';
    if (p.request.choice === 'redeliver' || p.request.choice === 'refuse') cls = 'bad';
    if (p.request.choice === 'someone') cls = 'ok';
    if (p.approval) {
      if (p.approval.status === 'approved') { t += ' · OK\'d by ' + p.approval.by + ', ' + p.approval.position + ' · photo required'; cls = 'ok'; }
      else if (p.approval.status === 'declined') { t += ' · pharmacy said NO: needs a signature'; cls = 'bad'; }
      else t += ' · waiting for the pharmacy\'s OK';
    }
    return [t, cls];
  }

  /** Tells the server the driver is on the way (once a day): patients start getting texts. */
  function started() {
    if (!me || !data || !data.route || data.date !== data.today || startedFor === data.date || data.started) return;
    startedFor = data.date;
    phloBackend.call('driver.start', { session: me.session, date: data.date }).catch(function () { startedFor = null; });
  }

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
  /** "Pharmacy wrote: ..." from the notes, when the office's route uses a corrected address. */
  function typedAddress(s) {
    return String(s.notes || '').split(' · ').filter(function (p) { return p.indexOf('Pharmacy wrote: ') === 0; })[0] || '';
  }

  function niceDate(iso) {
    var p = iso.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric' });
  }

  function saved() {
    try { var s = JSON.parse(localStorage.getItem(KEY) || 'null'); return s && s.session && s.expires > Date.now() ? s : null; } catch (e) { return null; }
  }

  /* ---------------- sign in / out ---------------- */

  function login(e) {
    e.preventDefault();
    var f = $('driver-login'), err = $('driver-login-error');
    var username = f.elements.username.value.trim(), pin = f.elements.pin.value.trim();
    err.hidden = true;
    if (!username || !pin) { err.textContent = 'Type your name and PIN.'; err.hidden = false; return; }
    var btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    phloBackend.call('driver.login', { username: username, pin: pin }).then(function (r) {
      me = { session: r.session, name: r.name, expires: r.expires };
      try { localStorage.setItem(KEY, JSON.stringify(me)); } catch (x) { /* storage blocked: signed in for this visit */ }
      f.reset();
      enter();
    }).catch(function (x) {
      err.textContent = x.message; err.hidden = false;
    }).then(function () { btn.disabled = false; });
  }

  function logout(silent) {
    if (me && !silent) phloBackend.call('driver.logout', { session: me.session }).catch(function () {});
    me = null; data = null;
    try { localStorage.removeItem(KEY); } catch (x) { /* storage blocked */ }
    clearInterval(refreshTimer);
    document.body.classList.remove('driver-mode');
    $('view-driver').hidden = true;
    $('driver-signout').hidden = true;
    $('who').textContent = '';
    $('dv-stops').textContent = '';
  }

  /** Session expired or removed: back to the sign-in screen with a message. */
  function authFailed(msg) {
    logout(true);
    var err = $('driver-login-error');
    err.textContent = msg || 'Please sign in again.'; err.hidden = false;
  }

  function enter() {
    document.body.classList.add('driver-mode');
    $('view-driver').hidden = false;
    $('driver-signout').hidden = false;
    $('who').textContent = me.name;
    $('dv-title').textContent = 'Hi ' + me.name.split(' ')[0];
    $('dv-sub').textContent = 'Loading your route…';
    load();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(function () { if (!document.hidden && !$('dv-stop').open) load(); }, 120000);
  }

  /* ---------------- route ---------------- */

  function load() {
    if (!me) return;
    phloBackend.call('driver.route', { session: me.session }).then(function (r) {
      data = r;
      render();
    }).catch(function (e) {
      if (e.auth) authFailed(e.message); else $('dv-sub').textContent = e.message;
    });
  }

  function render() {
    var list = $('dv-stops');
    list.textContent = '';
    if (!data.route) {
      $('dv-sub').textContent = 'No route has been sent to you yet.';
      $('dv-bar').style.width = '0';
      $('dv-next').hidden = true;
      list.appendChild(el('li', { class: 'dv-empty', text: 'Nothing to deliver right now. Pull to refresh or tap Refresh later.' }));
      return;
    }
    var stops = data.route.stops, done = 0, next = null;
    stops.forEach(function (s) { if (data.updates[s.id]) done++; else if (!next) next = s; });
    $('dv-sub').textContent = niceDate(data.date) + (data.date > data.today ? ' (coming up)' : data.date < data.today ? ' (past)' : '') +
      ' · ' + done + ' of ' + stops.length + ' done' + (data.route.start ? ' · start ' + phloClock(data.route.start) : '');
    $('dv-bar').style.width = (stops.length ? done / stops.length * 100 : 0) + '%';
    var nav = $('dv-next');
    nav.hidden = !next;
    if (next) { nav.href = phloNavUrl(next); nav.textContent = 'Navigate to stop ' + next.seq; }
    renderMsgs();
    stops.forEach(function (s) {
      var u = data.updates[s.id];
      var chips = el('div', { class: 'chips' });
      if (u) chips.appendChild(el('span', { class: 'chip ' + (u.status === 'delivered' ? 'ok' : 'bad'), text: u.status === 'delivered' ? 'Delivered' : 'Not delivered' }));
      (data.msgs || []).forEach(function (m) { if (m.stopId === s.id) chips.appendChild(el('span', { class: 'chip bad', text: m.text })); });
      var pc = !u && patientChip(patientOf(s));
      if (pc) chips.appendChild(el('span', { class: 'chip ' + pc[1], text: pc[0] }));
      if (s.copay) chips.appendChild(el('span', { class: 'chip warn', text: 'Copay ' + s.copay }));
      s.tags.forEach(function (t) { chips.appendChild(el('span', { class: 'chip', text: t })); });
      if (s.store) chips.appendChild(el('span', { class: 'chip', text: s.store }));
      var btn = el('button', { type: 'button', class: 'dv-stop' + (s === next ? ' next' : '') + (u ? ' done' + (u.status === 'failed' ? ' failed' : '') : '') }, [
        el('span', { class: 'seq', text: u ? (u.status === 'delivered' ? '✓' : '!') : String(s.seq) }),
        el('span', { class: 'nm' }, [el('span', { text: s.name }), el('span', { class: 'muted small', text: s.eta ? phloClock(s.eta) : '' })]),
        el('span', { class: 'ad', text: s.address }),
        typedAddress(s) ? el('span', { class: 'ad typed', text: typedAddress(s) }) : null,
        chips
      ]);
      btn.addEventListener('click', function () { openStop(s); });
      list.appendChild(el('li', {}, [btn]));
    });
  }

  /** Messages from the office or a pharmacy, newest first; unread ones have a "Got it" button. */
  function renderMsgs() {
    var msgs = (data.msgs || []).slice().reverse();
    var box = $('dv-msgs'), list = $('dv-msg-list');
    list.textContent = '';
    box.hidden = !msgs.length;
    msgs.forEach(function (m) {
      var li = el('li', { class: m.readAt ? 'read' : '' }, [
        el('span', {}, [el('b', { text: 'Stop ' + m.seq + ': ' }), m.text]),
        el('span', { class: 'muted small', text: m.from + ' · ' + new Date(m.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) })
      ]);
      if (!m.readAt) {
        var ok = el('button', { type: 'button', class: 'btn primary', text: 'Got it' });
        ok.addEventListener('click', function () {
          ok.disabled = true;
          phloBackend.call('driver.ack', { session: me.session, date: data.date, msgId: m.id }).then(function (r) {
            m.readAt = r.msg.readAt; renderMsgs();
          }).catch(function (x) { ok.disabled = false; toast(x.message); });
        });
        li.appendChild(ok);
      }
      list.appendChild(li);
    });
  }

  /* ---------------- stop form ---------------- */

  function openStop(s) {
    editing = s; photo = null;
    var u = data.updates[s.id] || null;
    var f = $('dv-form');
    f.reset();
    $('dv-stop-title').textContent = s.seq + '. ' + s.name;
    $('dv-stop-address').textContent = s.address + (typedAddress(s) ? ' (' + typedAddress(s) + ')' : '');
    var meta = $('dv-stop-meta');
    meta.textContent = '';
    if (s.eta) meta.appendChild(el('span', { class: 'chip', text: 'ETA ' + phloClock(s.eta) }));
    if (s.copay) meta.appendChild(el('span', { class: 'chip warn', text: 'Copay due ' + s.copay }));
    s.tags.forEach(function (t) { meta.appendChild(el('span', { class: 'chip', text: t })); });
    if (s.notes) meta.appendChild(el('span', { class: 'chip', text: s.notes }));
    var pbox = $('dv-patient'), pc = patientChip(patientOf(s));
    var msgs = (data.msgs || []).filter(function (m) { return m.stopId === s.id; });
    pbox.textContent = '';
    if (pc) pbox.appendChild(el('p', { class: 'chip ' + pc[1], text: pc[0] }));
    msgs.forEach(function (m) { pbox.appendChild(el('p', { class: 'chip bad', text: m.text + ' (' + m.from + ')' })); });
    pbox.hidden = !pbox.childNodes.length;
    $('dv-nav').href = phloNavUrl(s);
    var st = u ? u.status : 'delivered';
    Array.prototype.forEach.call(f.elements.status, function (r) { r.checked = r.value === st; });
    Array.prototype.forEach.call(f.elements.methods, function (c) { c.checked = !!u && u.methods.indexOf(c.value) >= 0; });
    f.elements.approvedBy.value = u ? u.approvedBy : '';
    if (!u && leaveOk(s)) {
      // The pharmacy OK'd leaving it: start the form that way (the driver can still change it).
      var p = patientOf(s);
      Array.prototype.forEach.call(f.elements.methods, function (c) { c.checked = c.value === p.request.choice || c.value === 'approved'; });
      f.elements.approvedBy.value = p.approval.by + ' (' + p.approval.position + ')';
    }
    f.elements.copayCollected.value = u ? u.copayCollected : '';
    $('dv-copay-field').hidden = !s.copay && !(u && u.copayCollected);
    f.elements.note.value = u ? u.note : '';
    toggleApproved();
    var prev = $('dv-photo-preview');
    prev.hidden = true; prev.removeAttribute('src');
    $('dv-errors').hidden = true;
    clearSig();
    var savedSig = $('dv-sig-saved');
    savedSig.hidden = true; savedSig.removeAttribute('src');
    $('dv-sig').hidden = false;
    $('dv-stop').showModal();
    sizeSig();
    // Show what was saved before.
    if (u && u.photoId) fetchFile(u.photoId, function (url) { if (editing === s && !photo) { prev.src = url; prev.hidden = false; } });
    if (u && u.signatureId) fetchFile(u.signatureId, function (url) {
      if (editing === s && !sig.ink) { savedSig.src = url; savedSig.hidden = false; $('dv-sig').hidden = true; }
    });
  }

  function fetchFile(id, then) {
    phloBackend.call('driver.file', { session: me.session, date: data.date, fileId: id }).then(function (r) { then(r.dataUrl); }).catch(function () {});
  }

  function toggleApproved() {
    var f = $('dv-form');
    var on = Array.prototype.some.call(f.elements.methods, function (c) { return c.value === 'approved' && c.checked; });
    f.elements.approvedBy.hidden = !on;
  }

  function closeStop() { $('dv-stop').close(); editing = null; photo = null; }

  function save(e) {
    e.preventDefault();
    if (!editing) return;
    var f = $('dv-form'), s = editing, old = data.updates[s.id] || {};
    var status = (f.querySelector('input[name="status"]:checked') || {}).value;
    var u = {
      status: status,
      methods: Array.prototype.filter.call(f.elements.methods, function (c) { return c.checked; }).map(function (c) { return c.value; }),
      approvedBy: f.elements.approvedBy.value.trim(),
      copayCollected: f.elements.copayCollected.value.trim(),
      note: f.elements.note.value.trim()
    };
    var errs = phloCheckUpdate(u, {
      leaveApproved: leaveOk(s),
      hasPhoto: !!photo || !!old.photoId,
      hasSignature: sig.ink || (!!old.signatureId && $('dv-sig').hidden)
    });
    var box = $('dv-errors');
    box.textContent = '';
    if (errs.length) {
      errs.forEach(function (m) { box.appendChild(el('li', { text: m })); });
      box.hidden = false;
      return;
    }
    box.hidden = true;
    u.photo = photo || '';
    u.keepPhoto = !photo && !!old.photoId;
    u.signature = sig.ink ? $('dv-sig').toDataURL('image/png') : '';
    u.keepSignature = !sig.ink && !!old.signatureId && $('dv-sig').hidden;
    var btn = $('dv-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    phloBackend.call('driver.update', { session: me.session, date: data.date, stopId: s.id, update: u }).then(function (r) {
      data.updates[s.id] = r.update;
      closeStop();
      render();
      toast('Saved stop ' + s.seq + '.');
    }).catch(function (x) {
      if (x.auth) { closeStop(); authFailed(x.message); return; }
      box.appendChild(el('li', { text: 'Not saved: ' + x.message + ' Your answers are still here: tap Save again.' }));
      box.hidden = false;
    }).then(function () { btn.disabled = false; btn.textContent = 'Save'; });
  }

  /* ---------------- photo ---------------- */

  function takePhoto(e) {
    var file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function () {
      var max = 1280, w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, max / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      photo = c.toDataURL('image/jpeg', 0.7);
      var prev = $('dv-photo-preview');
      prev.src = photo; prev.hidden = false;
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast('Could not read that photo.'); };
    img.src = url;
  }

  /* ---------------- signature ---------------- */

  function sizeSig() {
    var c = $('dv-sig'), r = c.getBoundingClientRect();
    if (!r.width) return;
    c.width = Math.round(r.width * 2); c.height = Math.round(r.height * 2);
    sig.ctx = c.getContext('2d');
    sig.ctx.fillStyle = '#ffffff'; sig.ctx.fillRect(0, 0, c.width, c.height);
    sig.ctx.lineWidth = 4; sig.ctx.lineCap = 'round'; sig.ctx.lineJoin = 'round'; sig.ctx.strokeStyle = '#111111';
    sig.ink = false;
  }
  function clearSig() {
    if (sig.ctx) { var c = $('dv-sig'); sig.ctx.fillStyle = '#ffffff'; sig.ctx.fillRect(0, 0, c.width, c.height); }
    sig.ink = false;
    var savedSig = $('dv-sig-saved');
    if (!savedSig.hidden) { savedSig.hidden = true; $('dv-sig').hidden = false; sizeSig(); }
  }
  function sigPoint(e) {
    var c = $('dv-sig'), r = c.getBoundingClientRect();
    return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height];
  }
  function sigDown(e) {
    if (!sig.ctx) sizeSig();
    e.preventDefault();
    $('dv-sig').setPointerCapture(e.pointerId);
    sig.drawing = true;
    var p = sigPoint(e);
    sig.ctx.beginPath(); sig.ctx.moveTo(p[0], p[1]); sig.ctx.lineTo(p[0] + 0.1, p[1] + 0.1); sig.ctx.stroke();
    sig.ink = true;
  }
  function sigMove(e) {
    if (!sig.drawing) return;
    var p = sigPoint(e);
    sig.ctx.lineTo(p[0], p[1]); sig.ctx.stroke();
  }
  function sigUp() { sig.drawing = false; }

  /* ---------------- wire up ---------------- */

  document.addEventListener('DOMContentLoaded', function () {
    if (!phloBackend.enabled || /^#t=/.test(location.hash)) return;
    $('driver-login').hidden = false;
    $('driver-login').addEventListener('submit', login);
    $('driver-signout').addEventListener('click', function () { logout(false); });
    $('dv-refresh').addEventListener('click', load);
    $('dv-next').addEventListener('click', started);
    $('dv-nav').addEventListener('click', started);
    $('dv-form').addEventListener('submit', save);
    $('dv-close').addEventListener('click', closeStop);
    $('dv-cancel').addEventListener('click', closeStop);
    $('dv-form').addEventListener('change', function (e) { if (e.target.name === 'methods') toggleApproved(); });
    $('dv-photo').addEventListener('change', takePhoto);
    $('dv-sig-clear').addEventListener('click', clearSig);
    var c = $('dv-sig');
    c.addEventListener('pointerdown', sigDown);
    c.addEventListener('pointermove', sigMove);
    c.addEventListener('pointerup', sigUp);
    c.addEventListener('pointercancel', sigUp);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && me && !$('dv-stop').open) load(); });
    me = saved();
    if (me) enter();
  });
})();
