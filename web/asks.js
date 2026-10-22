/* Pop-ups shared by the office (Dispatch tab) and pharmacy pages:
 *   phloAsk.approval({title, request, note}, submit)  - approve or decline leaving a delivery without a signature
 *   phloAsk.message({title, seq, askName}, submit)     - "Please RTS to RX" message for the driver
 * submit(answer) returns a Promise; the pop-up closes when it resolves and shows the error when it rejects. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  function errors(dlg, list) {
    var box = dlg.querySelector('.form-errors');
    box.textContent = '';
    list.forEach(function (m) { var li = document.createElement('li'); li.textContent = m; box.appendChild(li); });
    box.hidden = !list.length;
  }

  /** Runs submit(answer), with the buttons off while it works. */
  function run(dlg, answer, submit) {
    var btns = dlg.querySelectorAll('button');
    btns.forEach(function (b) { b.disabled = true; });
    submit(answer).then(function () { dlg.close(); }, function (e) { errors(dlg, [e.message]); })
      .then(function () { btns.forEach(function (b) { b.disabled = false; }); });
  }

  function approval(opts, submit) {
    var dlg = $('ask-approve'), f = dlg.querySelector('form');
    f.reset();
    errors(dlg, []);
    $('ask-approve-who').textContent = opts.title || '';
    $('ask-approve-req').textContent = opts.request || '';
    $('ask-approve-note').textContent = opts.note || '';
    dlg.onclick = function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-close')) { dlg.close(); return; }
      if (!b.hasAttribute('data-ok')) return;
      var ok = b.getAttribute('data-ok') === '1';
      var ans = { ok: ok, by: f.elements.by.value.trim(), position: f.elements.position.value.trim() };
      if (ok && (!ans.by || !ans.position)) { errors(dlg, ['Type the name and position of the pharmacy staff who approve it.']); return; }
      run(dlg, ans, submit);
    };
    dlg.showModal();
  }

  function message(opts, submit) {
    var dlg = $('ask-message'), f = dlg.querySelector('form');
    f.reset();
    errors(dlg, []);
    $('ask-message-who').textContent = (opts.seq ? 'Stop ' + opts.seq + ': ' : '') + (opts.title || '');
    $('ask-message-name').hidden = !opts.askName;
    var other = f.elements.other;
    var sync = function () { other.hidden = (f.querySelector('input[name="reason"]:checked') || {}).value !== 'other'; };
    f.onchange = sync;
    sync();
    dlg.onclick = function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-close')) { dlg.close(); return; }
      if (!b.hasAttribute('data-send')) return;
      var reason = (f.querySelector('input[name="reason"]:checked') || {}).value;
      var ans = { reason: reason, other: other.value.trim(), by: f.elements.by.value.trim() };
      if (!reason) { errors(dlg, ['Pick a reason.']); return; }
      if (reason === 'other' && !ans.other) { errors(dlg, ['Type the reason.']); return; }
      run(dlg, ans, submit);
    };
    dlg.showModal();
  }

  window.phloAsk = { approval: approval, message: message };
})();
