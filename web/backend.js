/* PHLO dispatch server client (the Apps Script web app in apps-script-dispatch/).
 * Requests are plain-text POSTs so the browser sends them without a CORS preflight. */
(function () {
  'use strict';
  var URL = (window.PHLO_CONFIG || {}).dispatchUrl || '';

  /** Calls a server action. Resolves with its reply; rejects with an Error (err.auth = must sign in again). */
  function call(action, payload) {
    if (!URL) return Promise.reject(new Error('The dispatch server is not set up yet (dispatchUrl in config.js).'));
    var body = JSON.stringify(Object.assign({ action: action }, payload || {}));
    return fetch(URL, { method: 'POST', body: body, redirect: 'follow' }).then(function (res) {
      if (!res.ok) throw new Error('The dispatch server answered ' + res.status + '.');
      return res.json();
    }, function () {
      throw new Error('Could not reach the dispatch server. Check the internet connection and try again.');
    }).then(function (r) {
      if (!r.ok) { var e = new Error(r.error || 'The dispatch server could not do that.'); e.auth = !!r.auth; throw e; }
      return r;
    });
  }

  window.phloBackend = { enabled: !!URL, call: call };
})();
