/**
 * PHLO DISPATCH SERVER (Google Apps Script web app)
 *
 * The PHLO page talks to this script to:
 *   - let drivers sign in with their username + PIN and see only their own route,
 *   - save what drivers record at each stop (outcome, photo, signature, copay),
 *   - let the PHLO Google account send routes and watch progress.
 *
 * Everything is kept in the "PHLO Dispatch" folder of the Google Drive that runs this script.
 * Setup: see README.md in this folder.
 */

var ADMINS = ['yourphlo@gmail.com'];      // Google accounts allowed to send routes and see everything
var TIME_ZONE = 'America/Los_Angeles';
var SESSION_HOURS = 16;                    // how long a driver stays signed in
var MAX_TRIES = 5, LOCK_MINUTES = 15;      // wrong PINs before a username is locked for a while
var FOLDER_NAME = 'PHLO Dispatch';

/* =========================== web entry points =========================== */

function doGet() {
  return out_({ ok: true, app: 'phlo-dispatch' });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'Bad request.' }); }
  try {
    var fn = ACTIONS[req.action];
    if (!fn) throw new Error('Unknown action.');
    var res = fn(req) || {};
    res.ok = true;
    return out_(res);
  } catch (err) {
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
      accounts[u] = { id: String(d.id), name: String(d.name || ''), salt: String(d.salt || ''), hash: String(d.hash || '') };
    });
    props_().setProperty('accounts', JSON.stringify(accounts));
    // Sessions of drivers who were removed or lost their PIN end now.
    var ids = {};
    Object.keys(accounts).forEach(function (u) { if (accounts[u].hash) ids[accounts[u].id] = true; });
    eachSession_(function (key, s) { if (!ids[s.driverId]) props_().deleteProperty(key); });
    return { accounts: Object.keys(accounts).length };
  },

  'admin.publish': function (req) {
    admin_(req);
    var date = isoDate_(req.date);
    var routes = (req.routes || []).map(function (r) {
      return {
        driverId: String(r.driverId), driverName: String(r.driverName || ''),
        startAddress: String(r.startAddress || ''), endAddress: String(r.endAddress || ''),
        start: r.start || '', finish: r.finish || '',
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
    withLock_(function () {
      writeJson_('routes-' + date + '.json', { date: date, publishedAt: new Date().toISOString(), routes: routes });
      var dates = JSON.parse(props_().getProperty('dates') || '[]');
      if (dates.indexOf(date) < 0) { dates.push(date); dates.sort(); props_().setProperty('dates', JSON.stringify(dates.slice(-120))); }
    });
    return { date: date, routes: routes.length };
  },

  'admin.status': function (req) {
    admin_(req);
    var date = isoDate_(req.date);
    var plan = readJson_('routes-' + date + '.json');
    return { date: date, plan: plan, updates: readJson_('updates-' + date + '.json') || {} };
  },

  'admin.file': function (req) {
    admin_(req);
    return { dataUrl: fileDataUrl_(req.fileId) };
  },

  'driver.login': function (req) {
    var u = String(req.username || '').trim().toLowerCase();
    var cache = CacheService.getScriptCache(), key = 'fails_' + u;
    var fails = +(cache.get(key) || 0);
    if (fails >= MAX_TRIES) throw authError_('Too many wrong tries. Wait ' + LOCK_MINUTES + ' minutes and try again.');
    var acc = JSON.parse(props_().getProperty('accounts') || '{}')[u];
    if (!acc || !acc.hash || hash_(acc.salt, String(req.pin || '').trim()) !== acc.hash) {
      cache.put(key, String(fails + 1), LOCK_MINUTES * 60);
      throw authError_('Wrong name or PIN.');
    }
    cache.remove(key);
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
    var s = session_(req);
    var dates = JSON.parse(props_().getProperty('dates') || '[]');
    var today = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
    // The asked date; else today's route; else the next one coming up; else the latest.
    var order = req.date ? [isoDate_(req.date)] :
      [today].concat(dates.filter(function (d) { return d > today; }), dates.filter(function (d) { return d < today; }).reverse());
    for (var i = 0; i < order.length; i++) {
      var plan = readJson_('routes-' + order[i] + '.json');
      var mine = plan && plan.routes.filter(function (r) { return r.driverId === s.driverId; })[0];
      if (!mine) continue;
      var all = readJson_('updates-' + order[i] + '.json') || {};
      var updates = {};
      mine.stops.forEach(function (st) { if (all[st.id]) updates[st.id] = all[st.id]; });
      return { date: order[i], today: today, name: s.name, route: mine, updates: updates };
    }
    return { date: null, today: today, name: s.name, route: null, updates: {} };
  },

  'driver.update': function (req) {
    var s = session_(req);
    var date = isoDate_(req.date);
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
      all[stop.id] = rec;
      writeJson_('updates-' + date + '.json', all);
    });
    return { update: rec };
  },

  'driver.file': function (req) {
    var s = session_(req);
    var date = isoDate_(req.date);
    var all = readJson_('updates-' + date + '.json') || {};
    var ok = Object.keys(all).some(function (k) {
      return all[k].driverId === s.driverId && (all[k].photoId === req.fileId || all[k].signatureId === req.fileId);
    });
    if (!ok) throw new Error('Not your file.');
    return { dataUrl: fileDataUrl_(req.fileId) };
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
  if (ADMINS.map(function (a) { return a.toLowerCase(); }).indexOf(email) < 0) throw authError_('This Google account cannot send routes.');
  return email;
}

function session_(req) {
  var raw = props_().getProperty('sess_' + String(req.session || ''));
  var s = raw && JSON.parse(raw);
  if (!s || s.exp < Date.now()) throw authError_('Please sign in again.');
  return s;
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
