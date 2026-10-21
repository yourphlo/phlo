// Runs apps-script-dispatch/Server.gs in Node with small in-memory stand-ins for the Apps Script services.
//   const server = require('./fake-apps-script')({ adminTokens: { tok: 'yourphlo@gmail.com' } });
//   server.post({ action: 'driver.login', ... })  -> parsed JSON reply
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

  const ctx = {
    JSON, Date, Math, String, Number, Object, Array, Error,
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => ({ text: t }) }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; }, getProperties: () => Object.assign({}, props) }) },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = String(v); }, remove: k => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      formatDate: () => opts.today || '2026-10-21',
      base64Decode: s => Buffer.from(s, 'base64'),
      base64Encode: b => Buffer.from(b.map(x => (x + 256) % 256)).toString('base64'),
      newBlob: (bytes, type, name) => ({ bytes, type, name })
    },
    UrlFetchApp: { fetch: (url, o) => {
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
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script-dispatch', 'Server.gs'), 'utf8'), ctx, { filename: 'Server.gs' });
  return {
    post: body => JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).text),
    files, props, cache
  };
};
