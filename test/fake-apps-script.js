// Runs apps-script-dispatch/Server.gs in Node with small in-memory stand-ins for the Apps Script services.
//   const server = require('./fake-apps-script')({ adminTokens: { tok: 'yourphlo@gmail.com' } });
//   server.post({ action: 'driver.login', ... })  -> parsed JSON reply
//   server.sms (texts sent through the fake Quo), server.mail, server.setNow('2026-10-22T10:00:00')
//   server.quo({ from, body, key, id })  -> a patient's text coming in (a Quo message.received event)
// The clock and dates are UTC (the server's time zone is ignored), and "now" is opts.now or setNow().
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

module.exports = function makeServer(opts) {
  opts = opts || {};
  const props = {}, cache = {};
  let nextId = 1;
  const files = {};   // id -> {name, parent, content (string|Buffer), type}
  const folders = {}; // id -> {name, parent}
  const mkFile = (parent, name, content, type) => { const id = 'f' + nextId++; files[id] = { id, name, parent, content, type }; return fileObj(id); };
  const fileObj = id => ({
    getId: () => id,
    setContent: t => { files[id].content = t; },
    getBlob: () => ({ getDataAsString: () => String(files[id].content), getContentType: () => files[id].type, getBytes: () => [...Buffer.from(files[id].content)] }),
    getParents: () => iter([folderObj(files[id].parent)])
  });
  const folderObj = id => ({
    getId: () => id,
    isTrashed: () => false,
    getParents: () => iter(folders[id].parent ? [folderObj(folders[id].parent)] : []),
    getFilesByName: n => iter(Object.values(files).filter(f => f.parent === id && f.name === n).map(f => fileObj(f.id))),
    getFoldersByName: n => iter(Object.entries(folders).filter(([k, f]) => f.parent === id && f.name === n).map(([k]) => folderObj(k))),
    createFile: (a, b, c) => typeof a === 'string' ? mkFile(id, a, b, c) : mkFile(id, a.name, a.bytes, a.type),
    createFolder: n => { const k = 'd' + nextId++; folders[k] = { name: n, parent: id }; return folderObj(k); }
  });
  const iter = list => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
  folders.root = { name: 'My Drive', parent: null };

  let now = opts.now ? Date.parse(opts.now + 'Z') : null;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (!a.length && now !== null) super(now); else super(...a); }
    static now() { return now !== null ? now : RealDate.now(); }
  }
  const sms = [], mail = [], triggers = [];
  const pad = n => (n < 10 ? '0' : '') + n;
  const ctx = {
    JSON, Date: FakeDate, Math, String, Number, Object, Array, Error,
    ContentService: { MimeType: { JSON: 'json', XML: 'xml' }, createTextOutput: t => ({ setMimeType: () => ({ text: t }) }) },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/fake/exec' }),
      getProjectTriggers: () => triggers.map(h => ({ getHandlerFunction: () => h })),
      newTrigger: h => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => triggers.push(h) }) }) })
    },
    MailApp: { sendEmail: (to, subject, body) => mail.push({ to, subject, body }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; }, getProperties: () => Object.assign({}, props) }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); }, remove: k => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, f) => {
        if (f === 'HH:mm') return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
        if (now === null) return opts.today || '2026-10-21';
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
      },
      base64Decode: s => Buffer.from(s, 'base64'),
      base64Encode: b => (typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b.map(x => (x + 256) % 256))).toString('base64'),
      newBlob: (bytes, type, name) => ({ bytes, type, name })
    },
    UrlFetchApp: { fetch: (url, o) => {
      if (/api\.quo\.com\/v1\/messages/.test(url)) {
        const req = JSON.parse(o.payload), to = req.to[0];
        const stopped = (opts.optedOut || []).indexOf(to) >= 0;
        if (!stopped) sms.push({ to, body: req.content, from: req.from, auth: o.headers.Authorization });
        return { getResponseCode: () => (stopped ? 400 : 202),
          getContentText: () => JSON.stringify(stopped ? { message: 'Recipient has opted out of messages from this number', code: '0200400', status: 400 } : { data: { id: 'AC' + sms.length } }) };
      }
      const tok = (o.headers.Authorization || '').replace('Bearer ', '');
      const email = (opts.adminTokens || {})[tok];
      return { getResponseCode: () => (email ? 200 : 401), getContentText: () => JSON.stringify({ user: { emailAddress: email } }) };
    } },
    DriveApp: {
      getFolderById: id => { if (!folders[id]) throw new Error('no'); return folderObj(id); },
      getFileById: id => { if (!files[id]) throw new Error('no'); return fileObj(id); },
      getFoldersByName: n => folderObj('root').getFoldersByName(n),
      createFolder: n => folderObj('root').createFolder(n)
    }
  };
  vm.createContext(ctx);
  for (const f of ['Texts.gs', 'Server.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script-dispatch', f), 'utf8'), ctx, { filename: f });
  if (opts.quo) Object.assign(props, { QUO_API_KEY: 'quokey', QUO_FROM: '+16265550000' });
  let inId = 0;
  return {
    post: body => JSON.parse(ctx.doPost({ parameter: {}, postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text),
    quo: p => JSON.parse(ctx.doPost({ parameter: { key: p.key }, postData: { contents: JSON.stringify({ id: 'EV' + (++inId), object: 'event', apiVersion: 'v3',
      type: p.type || 'message.received', data: { object: { id: p.id || 'ACin' + inId, object: 'message', from: p.from, to: '+16265550000',
        direction: 'incoming', body: p.body, status: 'received' } } }) } }).text),
    run: name => ctx[name](),
    setNow: iso => { now = Date.parse(iso + 'Z'); },
    clearTickCache: () => { delete cache.tick; },
    files, props, cache, sms, mail, triggers
  };
};
