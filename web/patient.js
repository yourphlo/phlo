/* PHLO patient reply page: the link in the "driver is on the way" text (…/phlo/#t=<key>).
 * Shows the delivery day and time in the patient's language and lets them say they can't be home
 * (redeliver another day, don't want it, someone else will receive it, or leave it at the door / in the
 * mailbox once the pharmacy approves). No sign-in: the key in the link finds the one stop it was sent for,
 * and the page shows no name, address or medication. Words are in texts.js (PHLO_PAGE). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var token = null, view = null, lang = 'en', note = '';
  var LOCALES = { en: 'en-US', es: 'es-US', zh: 'zh-CN', 'zh-Hant': 'zh-TW', vi: 'vi-VN', ko: 'ko-KR', tl: 'fil-PH' };

  function w(key, vals) { return phloFill((PHLO_PAGE[lang] || PHLO_PAGE.en)[key] || PHLO_PAGE.en[key], vals); }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k]; else if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  function niceDate(iso) {
    var p = String(iso).split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    try { return d.toLocaleDateString(LOCALES[lang] || 'en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }); }
    catch (e) { return iso; }
  }

  function addDays(iso, n) {
    var p = iso.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
    return d.toISOString().slice(0, 10);
  }

  /** What the patient answered, in their language. */
  function answerText(req) {
    var detail = req.detail;
    if (req.choice === 'redeliver' && req.data && req.data.date) detail = niceDate(req.data.date) + (req.data.time ? ', ' + w('t_' + req.data.time) : '');
    if (req.choice === 'someone' && req.data && req.data.name) detail = req.data.name + (req.data.relation ? ' (' + req.data.relation + ')' : '');
    return w('st_' + req.choice, { detail: detail || '' });
  }

  function call(action, extra) {
    return phloBackend.call(action, Object.assign({ token: token }, extra || {}));
  }

  function load() {
    call('patient.get').then(function (r) { view = r; lang = phloLang(r.lang); render(false); })
      .catch(function (e) { fail(e.message); });
  }

  function fail(msg) {
    $('pt-when').textContent = '';
    $('pt-body').textContent = '';
    var st = $('pt-status');
    st.textContent = msg; st.className = 'pt-status bad'; st.hidden = false;
  }

  function render(choosing) {
    document.documentElement.lang = lang;
    $('pt-lang-label').textContent = w('lang');
    $('pt-lang').value = lang;
    $('pt-title').textContent = w('title');
    $('pt-when').textContent = view.time ? w('when', { date: niceDate(view.date), time: view.time }) : w('when_day', { date: niceDate(view.date) });
    var st = $('pt-status'), body = $('pt-body');
    body.textContent = '';
    st.hidden = true;
    var say = function (text, cls) { st.textContent = text; st.className = 'pt-status ' + (cls || ''); st.hidden = false; };
    if (view.done) { say(view.done === 'delivered' ? w('done_delivered') : w('done_failed'), view.done === 'delivered' ? 'good' : ''); return; }
    if (view.expired) { say(w('expired')); return; }
    if (view.request && !choosing) {
      var lines = [note ? w('thanks') : '', answerText(view.request)];
      if (view.approval) lines.push(w('ap_' + view.approval.status));
      say(lines.filter(Boolean).join(' '), view.approval && view.approval.status === 'declined' ? 'bad' : 'good');
      var change = el('button', { type: 'button', class: 'btn wide-btn', text: w('change') });
      change.addEventListener('click', function () { note = ''; render(true); });
      body.appendChild(change);
      return;
    }
    body.appendChild(el('p', { class: 'muted', text: w('intro') }));
    var list = el('div', { class: 'pt-options' });
    PHLO_CHOICES.forEach(function (c, i) {
      var b = el('button', { type: 'button', class: 'btn pt-option', 'data-choice': c }, [el('span', { class: 'n', text: String(i + 1) }), el('span', { text: w('opt_' + c) })]);
      b.addEventListener('click', function () { form(c); });
      list.appendChild(b);
    });
    body.appendChild(list);
  }

  /** The few questions for one choice, then Send. */
  function form(choice) {
    var body = $('pt-body');
    body.textContent = '';
    var f = el('form', { class: 'pt-form', novalidate: '' });
    f.appendChild(el('h3', { text: w('opt_' + choice) }));
    if (choice === 'redeliver') {
      var date = el('input', { type: 'date', name: 'date', required: '', min: addDays(view.date, 1), value: addDays(view.date, 1) });
      var time = el('select', { name: 'time' });
      ['any', 'morning', 'afternoon', 'evening'].forEach(function (t) { time.appendChild(el('option', { value: t, text: w('t_' + t) })); });
      f.appendChild(el('label', { class: 'field' }, [w('f_date'), date]));
      f.appendChild(el('label', { class: 'field' }, [w('f_time'), time]));
    }
    if (choice === 'someone') {
      f.appendChild(el('label', { class: 'field' }, [w('f_name'), el('input', { name: 'name', required: '', autocomplete: 'off', maxlength: '60' })]));
      f.appendChild(el('label', { class: 'field' }, [w('f_relation'), el('input', { name: 'relation', autocomplete: 'off', maxlength: '40' })]));
    }
    if (phloNeedsApproval(choice)) f.appendChild(el('p', { class: 'muted', text: w('leave_note') }));
    var err = el('p', { class: 'form-errors', hidden: '' });
    f.appendChild(err);
    var send = el('button', { type: 'submit', class: 'btn primary', text: w('send') });
    var back = el('button', { type: 'button', class: 'btn ghost', text: w('back') });
    back.addEventListener('click', function () { render(true); });
    f.appendChild(el('div', { class: 'actions' }, [send, back]));
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = {};
      Array.prototype.forEach.call(f.elements, function (i) { if (i.name) data[i.name] = i.value.trim(); });
      if (choice === 'redeliver' && !data.date) { err.textContent = w('need_date'); err.hidden = false; return; }
      if (choice === 'someone' && !data.name) { err.textContent = w('need_name'); err.hidden = false; return; }
      send.disabled = true;
      call('patient.reply', { choice: choice, data: data }).then(function (r) {
        view = r; note = 'sent'; render(false);
      }).catch(function () {
        err.textContent = w('error'); err.hidden = false; send.disabled = false;
      });
    });
    body.appendChild(f);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var m = location.hash.match(/^#t=(\w+)/);
    if (!m) return;
    token = m[1];
    document.body.classList.add('patient-mode');
    $('view-patient').hidden = false;
    var sel = $('pt-lang');
    PHLO_LANGS.forEach(function (l) { sel.appendChild(el('option', { value: l.code, text: l.name })); });
    sel.addEventListener('change', function () {
      lang = phloLang(sel.value);
      if (view) render(false);
      call('patient.lang', { lang: lang }).catch(function () { /* the page still switches */ });
    });
    if (!phloBackend.enabled) { fail(PHLO_PAGE.en.error); return; }
    load();
  });
})();
