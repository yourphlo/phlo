/**
 * PHLO DISPATCH SERVER (Google Apps Script web app)
 *
 * The PHLO page talks to this script to:
 *   - let drivers sign in with their username + PIN and see only their own route,
 *   - save what drivers record at each stop (outcome, photo, signature, copay),
 *   - let the PHLO Google account send routes and watch progress,
 *   - text patients when their driver is about 30 minutes away, read their replies (by text or on the
 *     reply page), and pass them to the driver, the office and the pharmacy,
 *   - let a pharmacy sign in to approve "leave it at the door" requests and ask a driver to bring a stop back,
 *   - let the office or a pharmacy message a driver.
 *
 * Everything is kept in the "PHLO Dispatch" folder of the Google Drive that runs this script.
 * Texts go out through Twilio (Script properties TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM). Without them
 * nothing is texted; the office sees "not sent" on each stop. The words and rules are in Texts.gs.
 * Setup: see README.md in this folder.
 */

var ADMINS = ['yourphlo@gmail.com'];      // Google accounts allowed to send routes and see everything
var TIME_ZONE = 'America/Los_Angeles';
var SESSION_HOURS = 16;                    // how long a driver stays signed in
var MAX_TRIES = 5, LOCK_MINUTES = 15;      // wrong PINs before a username is locked for a while
var MAX_TRIES_LONG = 20, LOCK_HOURS = 6;   // wrong PINs in 6 hours before it is locked for 6 hours
var DRIVER_DAYS_BACK = 1;                  // drivers see their route for today, coming days and this many days back
var FOLDER_NAME = 'PHLO Dispatch';
var PAGE_URL = 'https://yourphlo.github.io/phlo/'; // the PHLO page (patients' reply links point here)

/* =========================== web entry points =========================== */

function doGet() {
  return out_({ ok: true, app: 'phlo-dispatch' });
}

function doPost(e) {
  if (e && e.parameter && e.parameter.MessageSid) return twilioIn_(e);
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'Bad request.' }); }
  try {
    var fn = ACTIONS[req.action];
    if (!fn) throw new Error('Unknown action.');
    var res = fn(req) || {};
    res.ok = true;
    audit_(req, true, '');
    return out_(res);
  } catch (err) {
    audit_(req, false, err.message);
    return out_({ ok: false, error: err.message, auth: !!err.auth });
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function authError_(msg) { var e = new Error(msg); e.auth = true; return e; }

var ACTIONS = {
  'admin.syncDrivers': function (req) {
    admin_(req);
    var accounts = {};
    (req.drivers || []).forEach(function (d) {
      var u = String(d.username || '').toLowerCase();
      if (!u || !d.id) return;
      accounts[u] = { id: String(d.id), name: String(d.name || ''), salt: String(d.salt || ''), hash: String(d.hash || ''),
        mobile: phloE164(d.mobile) };
    });
    props_().setProperty('accounts', JSON.stringify(accounts));
    // Sessions of drivers who were removed or lost their PIN end now.
    var ids = {};
    Object.keys(accounts).forEach(function (u) { if (accounts[u].hash) ids[accounts[u].id] = true; });
    eachSession_(function (key, s) { if (s.role !== 'rx' && !ids[s.driverId]) props_().deleteProperty(key); });
    return { accounts: Object.keys(accounts).length };
  },

  'admin.publish': function (req) {
    admin_(req);
    var date = isoDate_(req.date);
    var routes = (req.routes || []).map(function (r) {
      return {
        driverId: String(r.driverId), driverName: String(r.driverName || ''),
        startAddress: String(r.startAddress || ''), endAddress: String(r.endAddress || ''),
        start: r.start || '', finish: r.finish || '', serviceMin: +r.serviceMin || 0,
        stops: (r.stops || []).map(function (s) {
          return {
            id: String(s.id), seq: +s.seq || 0, name: String(s.name || ''), address: String(s.address || ''),
            store: String(s.store || ''), notes: String(s.notes || ''), copay: String(s.copay || ''),
            tags: (s.tags || []).map(String), eta: String(s.eta || ''),
            lat: typeof s.lat === 'number' ? s.lat : null, lng: typeof s.lng === 'number' ? s.lng : null
          };
        })
      };
    });
    // Phone numbers and languages stay out of the routes (drivers don't see them): they go in the texts file.
    var contacts = {};
    (req.routes || []).forEach(function (r) {
      (r.stops || []).forEach(function (s) {
        contacts[String(s.id)] = { phone: phloE164(s.phone), lang: phloLang(s.lang), key: String(s.key || '').slice(0, 200) };
      });
    });
    withLock_(function () {
      writeJson_('routes-' + date + '.json', { date: date, publishedAt: new Date().toISOString(), routes: routes });
      var dates = JSON.parse(props_().getProperty('dates') || '[]');
      if (dates.indexOf(date) < 0) { dates.push(date); dates.sort(); props_().setProperty('dates', JSON.stringify(dates.slice(-120))); }
      var texts = readTexts_(date), people = readJson_('patients.json') || {};
      routes.forEach(function (r) {
        r.stops.forEach(function (s) {
          var c = contacts[s.id], t = texts.stops[s.id] || { log: [] };
          if (t.phone !== c.phone) { t.optOut = false; }
          t.phone = c.phone; t.lang = c.lang; t.key = c.key; t.store = s.store; t.name = s.name; t.driverId = r.driverId;
          if (!t.token) t.token = newToken_(date);
          texts.stops[s.id] = t;
          if (c.key && c.phone) people[c.key] = { phone: c.phone, lang: c.lang, at: new Date().toISOString() };
        });
      });
      writeJson_('texts-' + date + '.json', texts);
      writeJson_('patients.json', people);
    });
    return { date: date, routes: routes.length, texting: twilioReady_() };
  },

  /** Saved phone numbers and languages: {keys: [...]} -> {patients: {key: {phone, lang}}}. */
  'admin.patients': function (req) {
    admin_(req);
    var people = readJson_('patients.json') || {}, out = {};
    (req.keys || []).forEach(function (k) { if (people[k]) out[k] = { phone: people[k].phone, lang: people[k].lang }; });
    return { patients: out };
  },

  /** Texting settings: minutes before arrival, and each pharmacy's contact + sign-in PIN. Saves when req.set is given. */
  'admin.textSettings': function (req) {
    admin_(req);
    if (req.set) withLock_(function () {
      var cur = settings_(), set = req.set;
      var lead = parseInt(set.leadMin, 10);
      cur.leadMin = lead >= 5 && lead <= 120 ? lead : PHLO_TEXT_LEAD_MIN;
      var accounts = JSON.parse(props_().getProperty('rxAccounts') || '{}'), pharmacies = {};
      Object.keys(set.pharmacies || {}).forEach(function (code) {
        var p = set.pharmacies[code] || {}, c = String(code).trim().toUpperCase().slice(0, 30), k = c.toLowerCase();
        if (!c) return;
        pharmacies[c] = { phone: phloE164(p.phone), email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(p.email || '').trim()) ? String(p.email).trim() : '' };
        var pin = String(p.pin || '').trim();
        if (pin) {
          if (!/^\d{6,8}$/.test(pin)) throw new Error('A pharmacy PIN must be 6 to 8 digits (' + c + ').');
          var salt = Utilities.getUuid();
          accounts[k] = { code: c, salt: salt, hash: hash_(salt, pin) };
          endRxSessions_(c);
        } else if (p.clearPin) { delete accounts[k]; endRxSessions_(c); }
      });
      Object.keys(accounts).forEach(function (k) { if (!pharmacies[accounts[k].code]) { endRxSessions_(accounts[k].code); delete accounts[k]; } });
      cur.pharmacies = pharmacies;
      props_().setProperty('textSettings', JSON.stringify(cur));
      props_().setProperty('rxAccounts', JSON.stringify(accounts));
      ensureTrigger_();
    });
    var st = settings_(), acc = JSON.parse(props_().getProperty('rxAccounts') || '{}'), shown = {};
    Object.keys(st.pharmacies).forEach(function (c) { shown[c] = { phone: st.pharmacies[c].phone, email: st.pharmacies[c].email, hasPin: !!acc[c.toLowerCase()] }; });
    var from = String(props_().getProperty('TWILIO_FROM') || '');
    return { ready: twilioReady_(), from: /^MG/.test(from) ? 'Messaging Service' : phloPhoneShow(from), leadMin: st.leadMin, pharmacies: shown, hookUrl: hookUrl_() };
  },

  /** The office approves or declines a patient's "leave it without a signature" request for the pharmacy. */
  'admin.approve': function (req) {
    var email = admin_(req);
    return { stop: approve_(isoDate_(req.date), String(req.stopId || ''), !!req.ok, req.by, req.position, 'office (' + email + ')') };
  },

  /** The office messages a driver about a stop ("Please RTS to RX ..."). */
  'admin.message': function (req) {
    admin_(req);
    return { msg: messageDriver_(isoDate_(req.date), String(req.stopId || ''), req.reason, req.other, 'PHLO office') };
  },

  /** Texts a patient their "driver is on the way" message now (to try texting, or when the driver asks). */
  'admin.textNow': function (req) {
    admin_(req);
    var date = isoDate_(req.date), id = String(req.stopId || ''), res = null;
    var plan = readJson_('routes-' + date + '.json');
    var stop = null;
    (plan ? plan.routes : []).forEach(function (r) { r.stops.forEach(function (s) { if (s.id === id) stop = s; }); });
    if (!stop) throw new Error('That stop is not on the routes sent for that day.');
    withLock_(function () {
      var texts = readTexts_(date), t = texts.stops[id];
      if (!t || !t.phone) throw new Error('This stop has no mobile number.');
      var eta = phloHhmmMin(stop.eta), now = nowMin_();
      var away = date === today_() && eta != null ? Math.max(5, Math.round((eta - now) / 5) * 5) : PHLO_TEXT_LEAD_MIN;
      res = sendEta_(t, away, eta != null ? eta : now + away);
      writeJson_('texts-' + date + '.json', texts);
    });
    return { sent: res };
  },

  'admin.status': function (req) {
    admin_(req);
    var date = isoDate_(req.date);
    tick_(false);
    var plan = readJson_('routes-' + date + '.json');
    return { date: date, plan: plan, updates: readJson_('updates-' + date + '.json') || {}, texts: readTexts_(date), texting: twilioReady_() };
  },

  'admin.file': function (req) {
    admin_(req);
    return { dataUrl: fileDataUrl_(req.fileId) };
  },

  'driver.login': function (req) {
    var u = String(req.username || '').trim().toLowerCase();
    var key = 'fails_' + u;
    checkTries_(key);
    var acc = JSON.parse(props_().getProperty('accounts') || '{}')[u];
    if (!acc || !acc.hash || hash_(acc.salt, String(req.pin || '').trim()) !== acc.hash) {
      failedTry_(key);
      throw authError_('Wrong name or PIN.');
    }
    CacheService.getScriptCache().remove(key);
    var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    var exp = Date.now() + SESSION_HOURS * 3600e3;
    eachSession_(function (k, s) { if (s.exp < Date.now()) props_().deleteProperty(k); });
    props_().setProperty('sess_' + token, JSON.stringify({ driverId: acc.id, name: acc.name, exp: exp }));
    return { session: token, name: acc.name, expires: exp };
  },

  'driver.logout': function (req) {
    props_().deleteProperty('sess_' + String(req.session || ''));
    return {};
  },

  'driver.route': function (req) {
    var s = driverSession_(req);
    tick_(false);
    var dates = JSON.parse(props_().getProperty('dates') || '[]');
    var today = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
    // The asked date; else today's route; else the next one coming up; else the latest.
    var first = driverFirstDay_();
    var order = req.date ? [driverDate_(req.date)] :
      [today].concat(dates.filter(function (d) { return d > today; }), dates.filter(function (d) { return d < today && d >= first; }).reverse());
    for (var i = 0; i < order.length; i++) {
      var plan = readJson_('routes-' + order[i] + '.json');
      var mine = plan && plan.routes.filter(function (r) { return r.driverId === s.driverId; })[0];
      if (!mine) continue;
      var all = readJson_('updates-' + order[i] + '.json') || {};
      var texts = readTexts_(order[i]);
      var updates = {}, notes = {};
      mine.stops.forEach(function (st) {
        if (all[st.id]) updates[st.id] = all[st.id];
        var t = texts.stops[st.id];
        if (t && (t.request || t.etaAt)) notes[st.id] = { request: t.request || null, approval: t.approval || null, texted: t.etaAt || '' };
      });
      var msgs = texts.msgs.filter(function (m) { return m.driverId === s.driverId; });
      return { date: order[i], today: today, name: s.name, route: mine, updates: updates, texts: notes, msgs: msgs,
        started: texts.started[s.driverId] || '' };
    }
    return { date: null, today: today, name: s.name, route: null, updates: {}, texts: {}, msgs: [] };
  },

  /** The driver is on the way (tapped Navigate): the "about 30 minutes away" texts start counting from now. */
  'driver.start': function (req) {
    var s = driverSession_(req);
    var date = isoDate_(req.date);
    if (date !== today_()) return {}; // only a route for today starts the texts
    withLock_(function () {
      var texts = readTexts_(date);
      if (!texts.started[s.driverId]) { texts.started[s.driverId] = new Date().toISOString(); writeJson_('texts-' + date + '.json', texts); }
    });
    tick_(true);
    return {};
  },

  /** The driver read a message from the office or a pharmacy. */
  'driver.ack': function (req) {
    var s = driverSession_(req);
    var date = isoDate_(req.date), msg = null;
    withLock_(function () {
      var texts = readTexts_(date);
      msg = texts.msgs.filter(function (m) { return m.id === req.msgId && m.driverId === s.driverId; })[0];
      if (!msg) throw new Error('Message not found.');
      if (!msg.readAt) { msg.readAt = new Date().toISOString(); writeJson_('texts-' + date + '.json', texts); }
    });
    return { msg: msg };
  },

  'driver.update': function (req) {
    var s = driverSession_(req);
    var date = driverDate_(req.date);
    var plan = readJson_('routes-' + date + '.json');
    var mine = plan && plan.routes.filter(function (r) { return r.driverId === s.driverId; })[0];
    var stop = mine && mine.stops.filter(function (st) { return st.id === req.stopId; })[0];
    if (!stop) throw new Error('That stop is not on your route.');
    var u = req.update || {};
    var methods = (u.methods || []).filter(function (m) { return ['mailbox', 'door', 'approved'].indexOf(m) >= 0; });
    var rec = {
      status: u.status === 'failed' ? 'failed' : 'delivered',
      methods: methods,
      approvedBy: methods.indexOf('approved') >= 0 ? String(u.approvedBy || '').slice(0, 80) : '',
      copayCollected: String(u.copayCollected || '').slice(0, 20),
      note: String(u.note || '').slice(0, 1000),
      driverId: s.driverId, driverName: s.name,
      at: new Date().toISOString()
    };
    var folder = null;
    var save = function (dataUrl, kind) {
      if (!dataUrl) return '';
      var m = String(dataUrl).match(/^data:(image\/(?:jpeg|png));base64,(.+)$/);
      if (!m) throw new Error('The ' + kind + ' could not be read.');
      folder = folder || subfolder_('files-' + date);
      var name = stop.id + '-' + kind + '-' + Date.now() + (m[1] === 'image/png' ? '.png' : '.jpg');
      return folder.createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name)).getId();
    };
    withLock_(function () {
      var all = readJson_('updates-' + date + '.json') || {};
      var old = all[stop.id] || {};
      rec.photoId = u.photo ? save(u.photo, 'photo') : (u.keepPhoto ? old.photoId || '' : '');
      rec.signatureId = u.signature ? save(u.signature, 'signature') : (u.keepSignature ? old.signatureId || '' : '');
      // Keep what was recorded before (a change never erases the earlier record).
      if (old.at) {
        var before = {};
        Object.keys(old).forEach(function (k) { if (k !== 'history') before[k] = old[k]; });
        rec.history = (old.history || []).concat([before]).slice(-20);
      }
      all[stop.id] = rec;
      writeJson_('updates-' + date + '.json', all);
    });
    tick_(true);
    return { update: rec };
  },

  'driver.file': function (req) {
    var s = driverSession_(req);
    var date = driverDate_(req.date);
    var all = readJson_('updates-' + date + '.json') || {};
    var ok = Object.keys(all).some(function (k) {
      return all[k].driverId === s.driverId && (all[k].photoId === req.fileId || all[k].signatureId === req.fileId);
    });
    if (!ok) throw new Error('Not your file.');
    return { dataUrl: fileDataUrl_(req.fileId) };
  },

  /* ---- the patient's reply page (the link in their text; no sign-in, the link is the key) ---- */

  'patient.get': function (req) {
    var found = byToken_(req.token);
    return patientView_(found);
  },

  'patient.reply': function (req) {
    var found = byToken_(req.token);
    var view = patientView_(found);
    if (view.expired || view.done) return view;
    var choice = String(req.choice || ''), data = req.data || {}, detail = '', keep = null;
    if (PHLO_CHOICES.indexOf(choice) < 0) throw new Error('Pick one of the choices.');
    if (choice === 'redeliver') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.date || ''))) throw new Error('Pick a day.');
      keep = { date: String(data.date), time: PHLO_TIME_WINDOWS[data.time] ? String(data.time) : 'any' };
      detail = phloRedeliverText(keep.date, keep.time);
    } else if (choice === 'someone') {
      var name = String(data.name || '').trim().slice(0, 60), rel = String(data.relation || '').trim().slice(0, 40);
      if (!name) throw new Error('Type the name of the person.');
      keep = { name: name, relation: rel };
      detail = name + (rel ? ' (' + rel + ')' : '');
    }
    withLock_(function () {
      var texts = readTexts_(found.date);
      reply_(found.date, texts, found.stopId, { choice: choice, detail: detail }, 'page', keep);
      writeJson_('texts-' + found.date + '.json', texts);
    });
    return patientView_(byToken_(req.token));
  },

  'patient.lang': function (req) {
    var found = byToken_(req.token);
    var lang = phloLang(req.lang);
    withLock_(function () {
      var texts = readTexts_(found.date), t = texts.stops[found.stopId];
      t.lang = lang;
      writeJson_('texts-' + found.date + '.json', texts);
      if (t.key) {
        var people = readJson_('patients.json') || {};
        if (people[t.key]) { people[t.key].lang = lang; writeJson_('patients.json', people); }
      }
    });
    return patientView_(byToken_(req.token));
  },

  /* ---- pharmacies: sign in with the store code + PIN the office set ---- */

  'rx.login': function (req) {
    var code = String(req.store || '').trim().toLowerCase();
    var key = 'rxfails_' + code;
    checkTries_(key);
    var acc = JSON.parse(props_().getProperty('rxAccounts') || '{}')[code];
    if (!acc || hash_(acc.salt, String(req.pin || '').trim()) !== acc.hash) {
      failedTry_(key);
      throw authError_('Wrong pharmacy or PIN.');
    }
    CacheService.getScriptCache().remove(key);
    var token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    var exp = Date.now() + SESSION_HOURS * 3600e3;
    eachSession_(function (k, s) { if (s.exp < Date.now()) props_().deleteProperty(k); });
    props_().setProperty('sess_' + token, JSON.stringify({ role: 'rx', code: acc.code, name: acc.code, exp: exp }));
    return { session: token, name: acc.code, expires: exp };
  },

  'rx.logout': function (req) {
    props_().deleteProperty('sess_' + String(req.session || ''));
    return {};
  },

  /** A pharmacy's stops for a day: who drives them, when, what happened, what the patient asked. */
  'rx.day': function (req) {
    var s = rxSession_(req);
    tick_(false);
    var dates = JSON.parse(props_().getProperty('dates') || '[]');
    var date = req.date ? isoDate_(req.date) : today_();
    var plan = readJson_('routes-' + date + '.json');
    var updates = readJson_('updates-' + date + '.json') || {}, texts = readTexts_(date);
    var stops = [];
    (plan ? plan.routes : []).forEach(function (r) {
      r.stops.forEach(function (st) {
        if (String(st.store).toUpperCase() !== s.code) return;
        stops.push(rxStop_(r, st, updates[st.id], texts));
      });
    });
    return { date: date, today: today_(), code: s.code, dates: dates.slice(-14), stops: stops };
  },

  'rx.approve': function (req) {
    var s = rxSession_(req);
    var date = isoDate_(req.date), id = String(req.stopId || '');
    rxOwns_(s, date, id);
    approve_(date, id, !!req.ok, req.by, req.position, 'pharmacy ' + s.code);
    return { ok: true };
  },

  /** The photo or signature the driver saved at one of the pharmacy's stops. */
  'rx.file': function (req) {
    var s = rxSession_(req);
    var date = isoDate_(req.date), id = String(req.stopId || '');
    rxOwns_(s, date, id);
    var u = (readJson_('updates-' + date + '.json') || {})[id];
    var fileId = u && (req.which === 'signature' ? u.signatureId : u.photoId);
    if (!fileId) throw new Error('Nothing saved.');
    return { dataUrl: fileDataUrl_(fileId) };
  },

  'rx.message': function (req) {
    var s = rxSession_(req);
    var date = isoDate_(req.date), id = String(req.stopId || '');
    rxOwns_(s, date, id);
    return { msg: messageDriver_(date, id, req.reason, req.other, 'Pharmacy ' + s.code + (req.by ? ' (' + String(req.by).slice(0, 60) + ')' : '')) };
  }
};

/* =========================== helpers =========================== */

function props_() { return PropertiesService.getScriptProperties(); }

function hash_(salt, pin) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b + 256) % 256).toString(16).replace(/^(.)$/, '0$1'); }).join('');
}

function isoDate_(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) throw new Error('Bad date.');
  return String(v);
}

/** The oldest day a driver can still open (only what they need: today, coming days, and yesterday). */
function driverFirstDay_() {
  return Utilities.formatDate(new Date(Date.now() - DRIVER_DAYS_BACK * 864e5), TIME_ZONE, 'yyyy-MM-dd');
}

function driverDate_(v) {
  var d = isoDate_(v);
  if (d < driverFirstDay_()) throw new Error('That route is closed. Ask the PHLO office if you need it.');
  return d;
}

/** Wrong-PIN limits: 5 tries, then 15 minutes; 20 tries in 6 hours, then 6 hours. */
function checkTries_(key) {
  var cache = CacheService.getScriptCache();
  if (+(cache.get(key + '_long') || 0) >= MAX_TRIES_LONG) throw authError_('Too many wrong tries. This sign-in is locked for a few hours; ask the PHLO office.');
  if (+(cache.get(key) || 0) >= MAX_TRIES) throw authError_('Too many wrong tries. Wait ' + LOCK_MINUTES + ' minutes and try again.');
}

function failedTry_(key) {
  var cache = CacheService.getScriptCache();
  cache.put(key, String(+(cache.get(key) || 0) + 1), LOCK_MINUTES * 60);
  cache.put(key + '_long', String(+(cache.get(key + '_long') || 0) + 1), LOCK_HOURS * 3600);
}

/* =========================== access log =========================== */

var WHO = ''; // who is making this request (set when their sign-in is checked)

// Actions that only show data. Pages refresh them every minute, so each is logged once an hour per person.
var AUDIT_VIEWS = { 'admin.status': 1, 'admin.patients': 1, 'admin.file': 1, 'admin.textSettings': 1, 'driver.route': 1,
  'driver.file': 1, 'rx.day': 1, 'rx.file': 1, 'patient.get': 1 };

/**
 * Writes who did what, and when, to "access-log/access-YYYY-MM-DD.json" in the PHLO Dispatch folder:
 * sign-ins (and wrong PINs), every change, and who looked at which day's deliveries. No patient details
 * are written, only the stop id. Keep these files (HIPAA asks for 6 years of records like this).
 */
function audit_(req, ok, err) {
  try {
    var action = String(req.action || '');
    if (!ACTIONS[action]) return;
    var who = WHO;
    if (!who) {
      if (action === 'driver.login') who = 'driver sign-in as "' + String(req.username || '').trim().toLowerCase().slice(0, 40) + '"';
      else if (action === 'rx.login') who = 'pharmacy sign-in as "' + String(req.store || '').trim().toUpperCase().slice(0, 30) + '"';
      else if (action.indexOf('patient.') === 0) who = 'patient reply link';
      else who = 'not signed in';
    }
    var date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.date || '')) ? String(req.date) : '';
    var stop = String(req.stopId || '').slice(0, 60), file = String(req.fileId || req.which || '').slice(0, 80);
    if (ok && action === 'admin.textSettings' && req.set) action = 'admin.textSettings (saved)';
    if (ok && AUDIT_VIEWS[action]) {
      var cache = CacheService.getScriptCache();
      var key = 'aud_' + hash_('audit', [who, action, date, stop, file].join('|')).slice(0, 40);
      if (cache.get(key)) return;
      cache.put(key, '1', 3600);
    }
    var entry = { at: new Date().toISOString(), who: who, action: action, ok: ok };
    if (date) entry.date = date;
    if (stop) entry.stop = stop;
    if (file) entry.file = file;
    if (!ok) entry.error = String(err || '').slice(0, 200);
    withLock_(function () {
      var name = 'access-' + today_() + '.json', folder = subfolder_('access-log');
      var it = folder.getFilesByName(name), f = it.hasNext() ? it.next() : null;
      var list = f ? JSON.parse(f.getBlob().getDataAsString() || '[]') : [];
      list.push(entry);
      if (f) f.setContent(JSON.stringify(list));
      else folder.createFile(name, JSON.stringify(list), 'application/json');
    });
  } catch (e) { /* the log must never stop the app */ }
  WHO = '';
}

/** Checks the Google sign-in token the PHLO page sends and that it belongs to an admin account. */
function admin_(req) {
  var token = String(req.googleToken || '');
  if (!token) throw authError_('Sign in with Google first.');
  var cache = CacheService.getScriptCache();
  var key = 'adm_' + hash_('admin', token).slice(0, 40);
  var email = cache.get(key);
  if (!email) {
    var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
      { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw authError_('Your Google sign-in has expired. Sign in again.');
    email = String((JSON.parse(res.getContentText()).user || {}).emailAddress || '').toLowerCase();
    cache.put(key, email, 600);
  }
  WHO = 'office ' + email;
  if (ADMINS.map(function (a) { return a.toLowerCase(); }).indexOf(email) < 0) throw authError_('This Google account cannot send routes.');
  return email;
}

function session_(req) {
  var raw = props_().getProperty('sess_' + String(req.session || ''));
  var s = raw && JSON.parse(raw);
  if (!s || s.exp < Date.now()) throw authError_('Please sign in again.');
  WHO = s.role === 'rx' ? 'pharmacy ' + s.code : 'driver ' + s.name + ' (' + s.driverId + ')';
  return s;
}

function driverSession_(req) {
  var s = session_(req);
  if (s.role === 'rx') throw authError_('Please sign in again.');
  return s;
}

function rxSession_(req) {
  var s = session_(req);
  if (s.role !== 'rx') throw authError_('Please sign in again.');
  return s;
}

function endRxSessions_(code) {
  eachSession_(function (k, s) { if (s.role === 'rx' && s.code === code) props_().deleteProperty(k); });
}

function eachSession_(fn) {
  var all = props_().getProperties();
  Object.keys(all).forEach(function (k) { if (k.indexOf('sess_') === 0) fn(k, JSON.parse(all[k])); });
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function folder_() {
  var id = props_().getProperty('folderId');
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* gone */ } }
  var it = DriveApp.getFoldersByName(FOLDER_NAME);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
  props_().setProperty('folderId', folder.getId());
  return folder;
}

function subfolder_(name) {
  var it = folder_().getFoldersByName(name);
  return it.hasNext() ? it.next() : folder_().createFolder(name);
}

function readJson_(name) {
  var it = folder_().getFilesByName(name);
  return it.hasNext() ? JSON.parse(it.next().getBlob().getDataAsString()) : null;
}

function writeJson_(name, obj) {
  var text = JSON.stringify(obj);
  var it = folder_().getFilesByName(name);
  if (it.hasNext()) it.next().setContent(text);
  else folder_().createFile(name, text, 'application/json');
}

/** A photo or signature saved by this script, as a data: URL. Only files inside the PHLO Dispatch folder. */
function fileDataUrl_(fileId) {
  var file = DriveApp.getFileById(String(fileId || ''));
  var parents = file.getParents(), inside = false;
  while (parents.hasNext()) {
    var p = parents.next();
    var gp = p.getParents();
    while (gp.hasNext()) if (gp.next().getId() === folder_().getId()) inside = true;
  }
  if (!inside) throw new Error('Not a PHLO dispatch file.');
  var blob = file.getBlob();
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

/* =========================== texting =========================== */

/** Runs every 5 minutes (set up by itself when the office saves the texting settings): sends "on the way" texts. */
function textingTick() { tick_(true); }

/** Run once by hand from the Apps Script editor to start the 5-minute timer (saving the texting settings does it too). */
function setUpTexting() { ensureTrigger_(); }

function ensureTrigger_() {
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'textingTick'; });
  if (!has) ScriptApp.newTrigger('textingTick').timeBased().everyMinutes(5).create();
}

function today_() { return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd'); }
function minOfDay_(d) { return phloHhmmMin(Utilities.formatDate(new Date(d), TIME_ZONE, 'HH:mm')); }
function nowMin_() { return minOfDay_(new Date()); }
function pageUrl_() { return props_().getProperty('PAGE_URL') || PAGE_URL; }

function settings_() {
  var s = JSON.parse(props_().getProperty('textSettings') || '{}');
  return { leadMin: s.leadMin || PHLO_TEXT_LEAD_MIN, pharmacies: s.pharmacies || {} };
}

/** A day's texts: {stops: {stopId: {phone, lang, token, log, etaAt, request, approval, ...}}, msgs: [], started: {driverId: iso}}. */
function readTexts_(date) {
  var t = readJson_('texts-' + date + '.json') || {};
  return { stops: t.stops || {}, msgs: t.msgs || [], started: t.started || {} };
}

/** The patient's link key: the date (yymmdd) + 14 random characters. */
function newToken_(date) {
  return date.slice(2).replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 14);
}

function twilioReady_() {
  var p = props_();
  return !!(p.getProperty('TWILIO_SID') && p.getProperty('TWILIO_TOKEN') && p.getProperty('TWILIO_FROM'));
}

/** The web address Twilio sends patients' replies to (paste it in Twilio: phone number > Messaging > "A message comes in"). */
function hookUrl_() {
  var key = props_().getProperty('HOOK_KEY');
  if (!key) { key = Utilities.getUuid().replace(/-/g, ''); props_().setProperty('HOOK_KEY', key); }
  var url = '';
  try { url = ScriptApp.getService().getUrl(); } catch (e) { /* not deployed yet */ }
  return url ? url + '?key=' + key : '';
}

/** Sends one text. Returns {ok, sid} or {ok: false, err, code}. */
function sendSms_(to, body) {
  if (!to) return { ok: false, err: 'No mobile number.' };
  if (!twilioReady_()) return { ok: false, err: 'Texting is not set up yet (Twilio).' };
  var p = props_(), sid = p.getProperty('TWILIO_SID'), from = p.getProperty('TWILIO_FROM');
  var payload = { To: to, Body: body };
  if (/^MG/.test(from)) payload.MessagingServiceSid = from; else payload.From = from;
  try {
    var res = UrlFetchApp.fetch('https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json', {
      method: 'post', payload: payload, muteHttpExceptions: true,
      headers: { Authorization: 'Basic ' + Utilities.base64Encode(sid + ':' + p.getProperty('TWILIO_TOKEN')) }
    });
    var j = {};
    try { j = JSON.parse(res.getContentText() || '{}'); } catch (e) { /* not JSON */ }
    if (res.getResponseCode() >= 300) return { ok: false, err: j.message || 'Twilio answered ' + res.getResponseCode() + '.', code: j.code || 0 };
    return { ok: true, sid: j.sid || '' };
  } catch (e) {
    return { ok: false, err: 'Could not reach Twilio: ' + e.message };
  }
}

/** Texts a patient (t = their entry in the texts file) and logs it there. */
function textPatient_(t, kind, body) {
  var r = sendSms_(t.phone, body);
  if (!r.ok && r.code === 21610) t.optOut = true; // they replied STOP earlier
  t.log = (t.log || []).concat([{ dir: 'out', kind: kind, text: body, at: new Date().toISOString(), ok: r.ok, err: r.err || '' }]).slice(-30);
  return r;
}

/** The "driver is about N minutes away" text. at = minute of the day they should arrive. */
function sendEta_(t, min, at) {
  var body = phloSms(t.lang, 'eta', { min: min, time: phloMinClock(at), link: pageUrl_() + '#t=' + t.token });
  var r = textPatient_(t, 'eta', body);
  t.etaAt = new Date().toISOString();
  t.etaMin = min;
  return r;
}

/**
 * Sends the "on the way" texts that are due on today's routes (see phloTextDue in Texts.gs).
 * Runs at most once a minute unless forced (a driver just recorded a stop or started).
 */
function tick_(force) {
  var cache = CacheService.getScriptCache();
  if (!force && cache.get('tick')) return;
  cache.put('tick', '1', 50);
  var date = today_();
  var plan = readJson_('routes-' + date + '.json');
  if (!plan) return;
  var lead = settings_().leadMin;
  withLock_(function () {
    var texts = readTexts_(date), updates = readJson_('updates-' + date + '.json') || {}, now = nowMin_(), changed = false;
    plan.routes.forEach(function (route) {
      var done = {};
      route.stops.forEach(function (s) { if (updates[s.id]) done[s.id] = minOfDay_(updates[s.id].at); });
      var st = texts.started[route.driverId];
      var started = st && Utilities.formatDate(new Date(st), TIME_ZONE, 'yyyy-MM-dd') === date ? minOfDay_(st) : null;
      phloTextDue(route, done, started, now, lead).forEach(function (due) {
        var t = texts.stops[due.id];
        if (!t || !t.phone || t.etaAt || t.optOut) return;
        if (t.request && (t.request.choice === 'redeliver' || t.request.choice === 'refuse')) return;
        sendEta_(t, due.min, due.at);
        changed = true;
      });
    });
    if (changed) writeJson_('texts-' + date + '.json', texts);
  });
}

/** Where a stop is on a day's routes: {route, stop} or null. */
function findStop_(date, stopId) {
  var plan = readJson_('routes-' + date + '.json'), out = null;
  (plan ? plan.routes : []).forEach(function (r) { r.stops.forEach(function (s) { if (s.id === stopId) out = { route: r, stop: s }; }); });
  return out;
}

function driverMobile_(driverId) {
  var acc = JSON.parse(props_().getProperty('accounts') || '{}'), m = '';
  Object.keys(acc).forEach(function (u) { if (acc[u].id === driverId && acc[u].mobile) m = acc[u].mobile; });
  return m;
}

/** Texts the driver of a stop (only on its delivery day, and only while the stop isn't recorded yet). */
function textDriver_(date, stopId, body) {
  if (date !== today_()) return null;
  var f = findStop_(date, stopId);
  if (!f) return null;
  var updates = readJson_('updates-' + date + '.json') || {};
  if (updates[stopId]) return null;
  var to = driverMobile_(f.route.driverId);
  return to ? sendSms_(to, 'PHLO stop ' + f.stop.seq + ' (' + f.stop.name + '): ' + body) : null;
}

/**
 * A patient's answer (by text or on the reply page). parsed: {choice, detail}; via: 'sms' | 'page'.
 * Saves it, answers the patient by text (for texts), asks the pharmacy when it needs their OK, and tells the driver.
 */
function reply_(date, texts, stopId, parsed, via, data) {
  var t = texts.stops[stopId], link = pageUrl_() + '#t=' + t.token;
  var choice = parsed.choice, detail = parsed.detail;
  // Words sent after "1" or "3" alone: the day, or the person's name.
  if (!choice && t.request && phloReplyNeedsDetail(t.request.choice, t.request.detail) && detail) choice = t.request.choice;
  if (!choice) { if (via === 'sms') textPatient_(t, 'unknown', phloSms(t.lang, 'unknown', { link: link })); return; }
  t.request = { choice: choice, detail: String(detail || '').slice(0, 300), data: data || null, at: new Date().toISOString(), via: via };
  t.approval = phloNeedsApproval(choice) ? { status: 'pending', at: t.request.at } : null;
  if (via === 'sms') {
    var key = phloReplyNeedsDetail(choice, detail) ? 'got_' + choice + '_ask' :
      phloNeedsApproval(choice) ? 'got_leave' : 'got_' + choice;
    textPatient_(t, 'reply', phloSms(t.lang, key, { detail: detail, link: link }));
  }
  if (phloNeedsApproval(choice)) askPharmacy_(t, choice);
  if (!phloReplyNeedsDetail(choice, detail)) textDriver_(date, stopId, 'patient says: ' + phloRequestText(t.request) + (phloNeedsApproval(choice) ? ' (waiting for the pharmacy\'s OK)' : ''));
}

/** Tells the pharmacy (text and/or email, as set on the Dispatch tab) that a patient wants it left without a signature. */
function askPharmacy_(t, choice) {
  var p = settings_().pharmacies[String(t.store || '').toUpperCase()];
  if (!p) return;
  var rx = (String(t.name).match(/\d{5,}/g) || []).join(', ');
  var body = 'PHLO: a patient (RX ' + rx + ') asks to leave today\'s delivery ' + (choice === 'door' ? 'at the front door' : 'in the mailbox') +
    ' without a signature. Approve or decline: ' + pageUrl_() + ' > Pharmacy sign-in.';
  var notes = [];
  if (p.phone) { var r = sendSms_(p.phone, body); notes.push('text ' + (r.ok ? 'sent' : 'not sent: ' + r.err)); }
  if (p.email) {
    // Email (a regular Gmail account) gets no RX number: the pharmacy sees which patient after signing in.
    var mail = 'PHLO: a patient asks to leave a delivery ' + (choice === 'door' ? 'at the front door' : 'in the mailbox') +
      ' without a signature. Sign in to approve or decline: ' + pageUrl_() + ' > Pharmacy sign-in.';
    try { MailApp.sendEmail(p.email, 'PHLO: approval needed', mail); notes.push('email sent'); }
    catch (e) { notes.push('email not sent: ' + e.message); }
  }
  t.approval.asked = notes.join('; ');
}

/** The pharmacy's (or the office's) answer to a leave-it-without-a-signature request. */
function approve_(date, stopId, ok, by, position, via) {
  by = String(by || '').trim().slice(0, 60); position = String(position || '').trim().slice(0, 60);
  if (ok && (!by || !position)) throw new Error('Type the name and position of the pharmacy staff who approve it.');
  var out = null;
  withLock_(function () {
    var texts = readTexts_(date), t = texts.stops[stopId];
    if (!t || !t.request || !phloNeedsApproval(t.request.choice)) throw new Error('This patient has not asked to leave it without a signature.');
    t.approval = { status: ok ? 'approved' : 'declined', by: by, position: position, at: new Date().toISOString(), via: via };
    if (t.phone) textPatient_(t, 'approval', phloSms(t.lang, ok ? 'approved_' + t.request.choice : 'declined'));
    writeJson_('texts-' + date + '.json', texts);
    out = t;
  });
  textDriver_(date, stopId, ok ? 'pharmacy OK\'d leaving it ' + (out.request.choice === 'door' ? 'at the front door' : 'in the mailbox') +
    ' with no signature (approved by ' + by + ', ' + position + '). Take a photo.' : 'the pharmacy said someone must sign for it.');
  return out;
}

/** A message for the driver of a stop ("Please RTS to RX [ticket, name]: reason"), in the app and by text. */
function messageDriver_(date, stopId, reason, other, from) {
  var f = findStop_(date, stopId);
  if (!f) throw new Error('That stop is not on the routes sent for that day.');
  if (!PHLO_RTS_REASONS.some(function (r) { return r.value === reason; })) throw new Error('Pick a reason.');
  if (reason === 'other' && !String(other || '').trim()) throw new Error('Type the reason.');
  var rx = (String(f.stop.name).match(/\d{5,}/g) || []).join(', ');
  var name = String(f.stop.name).replace(/^[\d,\s]+/, '');
  var msg = { id: Utilities.getUuid().slice(0, 8), driverId: f.route.driverId, stopId: stopId, seq: f.stop.seq,
    text: phloRtsText(rx, name, reason, String(other || '').slice(0, 200)), from: from, at: new Date().toISOString(), readAt: '' };
  var to = driverMobile_(f.route.driverId);
  var r = to ? sendSms_(to, 'PHLO: ' + msg.text + ' (from ' + from + '). Stop ' + f.stop.seq + '.') : { ok: false, err: 'No mobile number for this driver.' };
  msg.texted = r.ok; msg.err = r.ok ? '' : r.err;
  withLock_(function () {
    var texts = readTexts_(date);
    texts.msgs.push(msg);
    writeJson_('texts-' + date + '.json', texts);
  });
  return msg;
}

/** The stop a patient's link points to: {date, stopId, t}. */
function byToken_(token) {
  token = String(token || '');
  if (!/^\d{6}[0-9a-f]{14}$/.test(token)) throw new Error('This link is not right.');
  var date = '20' + token.slice(0, 2) + '-' + token.slice(2, 4) + '-' + token.slice(4, 6);
  var texts = readTexts_(date);
  var id = Object.keys(texts.stops).filter(function (k) { return texts.stops[k].token === token; })[0];
  if (!id) throw new Error('This link is not right.');
  return { date: date, stopId: id, t: texts.stops[id] };
}

/** What the reply page shows: the day and time, what the patient answered, and whether it's still open. */
function patientView_(found) {
  var f = findStop_(found.date, found.stopId), t = found.t;
  var updates = readJson_('updates-' + found.date + '.json') || {}, u = updates[found.stopId];
  var at = t.etaAt && t.etaMin ? minOfDay_(t.etaAt) + t.etaMin : f && phloHhmmMin(f.stop.eta);
  return {
    date: found.date, time: at != null ? phloMinClock(at) : '', lang: phloLang(t.lang),
    request: t.request ? { choice: t.request.choice, detail: t.request.detail, data: t.request.data } : null,
    approval: t.approval ? { status: t.approval.status } : null,
    done: u ? u.status : '', expired: !f || found.date < today_()
  };
}

/** One of a pharmacy's stops for the pharmacy page. */
function rxStop_(route, st, u, texts) {
  var t = texts.stops[st.id] || {};
  return {
    id: st.id, seq: st.seq, name: st.name, address: st.address, eta: st.eta, driverName: route.driverName,
    update: u ? { status: u.status, methods: u.methods, approvedBy: u.approvedBy, note: u.note, at: u.at, photo: !!u.photoId, signature: !!u.signatureId } : null,
    hasPhone: !!t.phone, texted: t.etaAt || '', request: t.request || null, approval: t.approval || null,
    msgs: texts.msgs.filter(function (m) { return m.stopId === st.id; })
  };
}

function rxOwns_(s, date, stopId) {
  var f = findStop_(date, stopId);
  if (!f || String(f.stop.store).toUpperCase() !== s.code) throw new Error('That stop is not one of your deliveries.');
}

/** A text from a patient (Twilio posts it here). Answers with an empty reply: anything we say goes out by sendSms_. */
function twilioIn_(e) {
  var p = e.parameter, xml = ContentService.createTextOutput('<Response></Response>').setMimeType(ContentService.MimeType.XML);
  var key = props_().getProperty('HOOK_KEY');
  if (!key || p.key !== key) return xml;
  var from = phloE164(p.From), body = String(p.Body || '').slice(0, 1000);
  if (!from) return xml;
  // The patient's stop: the newest day (today or before, up to 3 days back) whose texts went to this number.
  var dates = JSON.parse(props_().getProperty('dates') || '[]'), today = today_();
  var days = dates.filter(function (d) { return d <= today; }).reverse().slice(0, 3);
  for (var i = 0; i < days.length; i++) {
    var texts = readTexts_(days[i]);
    var ids = Object.keys(texts.stops).filter(function (k) { return texts.stops[k].phone === from; });
    if (!ids.length) continue;
    ids.sort(function (a, b) { return String(texts.stops[b].etaAt || '').localeCompare(String(texts.stops[a].etaAt || '')); });
    var date = days[i], id = ids[0];
    withLock_(function () {
      var fresh = readTexts_(date), t = fresh.stops[id];
      t.log = (t.log || []).concat([{ dir: 'in', text: body, at: new Date().toISOString() }]).slice(-30);
      var parsed = phloParseReply(body);
      if (/^\s*(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|START|UNSTOP|HELP|INFO)\s*$/i.test(body)) {
        t.optOut = /^\s*(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)\s*$/i.test(body);
      } else {
        var updates = readJson_('updates-' + date + '.json') || {};
        if (updates[id] || date < today) textPatient_(t, 'closed', phloSms(t.lang, 'closed'));
        else reply_(date, fresh, id, parsed, 'sms', null);
      }
      writeJson_('texts-' + date + '.json', fresh);
    });
    return xml;
  }
  return xml;
}
