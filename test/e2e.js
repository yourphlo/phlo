// End-to-end test of the web app in Chromium with Google's APIs faked from the local sheet snapshots.
//   XLSX_JS=/path/xlsx.full.min.js node test/e2e.js [final.xlsx-to-compare] [screenshot-dir]
// Needs: playwright, test/fixtures/ (local only), test/fixtures/ARC2.xlsx (optional).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const fx = path.join(__dirname, 'fixtures');
const xlsxJs = process.env.XLSX_JS;
const compareFile = process.argv[2];
const shotDir = process.argv[3];
if (!fs.existsSync(fx) || !xlsxJs) { console.log('e2e skipped (needs test/fixtures and XLSX_JS)'); process.exit(0); }
const XLSX = require(xlsxJs);

// Load store config to map sheet ids -> fixtures.
const vm = require('vm');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'web/stores.js'), 'utf8'), ctx);
const TAB = { WT: 'RX OCT 2026', 'WT DME': 'DME OCT 2026', EM: 'OCT 2026🎃', ARC: 'October 2026', SG: 'October 2026', ARC2: 'OCT-2026' };
const byId = {};
for (const s of ctx.STORES) {
  if (!s.id) continue;
  byId[s.id] = byId[s.id] || [];
  byId[s.id].push({ code: s.code, tab: TAB[s.code] || 'OCT 2026', xlsx: !!s.xlsx });
}
const fixture = code => JSON.parse(fs.readFileSync(path.join(fx, code.replace(' ', '_') + '.json'), 'utf8'));

function arc2Xlsx() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fixture('ARC2')), 'OCT-2026');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['old']]), 'SEP-2026');
  return Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

const server = http.createServer((req, res) => {
  const f = path.join(root, 'web', decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!f.startsWith(path.join(root, 'web')) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' });
  fs.createReadStream(f).pipe(res);
});

const FAKE_GSI = `window.google = { accounts: { oauth2: {
  initTokenClient: (o) => ({ requestAccessToken: () => setTimeout(() => o.callback({ access_token: 'fake', expires_in: 3600 }), 10) }),
  revoke: (t, cb) => cb && cb() } } };`;

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => process.env.DEBUG && console.log('console:', m.text()));
  page.on('response', r => process.env.DEBUG && r.status() >= 400 && console.log('resp', r.status(), r.url()));

  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.route(/accounts\.google\.com\/gsi\/client/, r => r.fulfill({ contentType: 'text/javascript', body: FAKE_GSI }));
  await page.route(/cdnjs\.cloudflare\.com\/.*xlsx/, r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(xlsxJs) }));
  await page.route(/googleapis\.com/, async route => {
    const url = new URL(route.request().url());
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/drive/v3/about')) return json({ user: { emailAddress: 'test@example.com' } });
    let m = url.pathname.match(/\/drive\/v3\/files\/([^/]+)$/);
    if (m) {
      const stores = byId[m[1]];
      if (!stores) return route.fulfill({ status: 404, body: '{}' });
      if (url.searchParams.get('alt') === 'media') return route.fulfill({ contentType: 'application/octet-stream', body: arc2Xlsx() });
      return json({ name: stores[0].code, mimeType: stores[0].xlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.google-apps.spreadsheet', modifiedTime: new Date(Date.now() - 3600e3).toISOString() });
    }
    if (url.pathname.endsWith('/drive/v3/files')) return json({ files: [] }); // BP search: nothing in October
    m = url.pathname.match(/\/v4\/spreadsheets\/([^/]+)(\/values:batchGet)?$/);
    if (m) {
      const stores = byId[m[1]] || [];
      if (!m[2]) return json({ sheets: stores.map(s => ({ properties: { title: s.tab } })).concat([{ properties: { title: 'SEPT 2026' } }]) });
      const ranges = url.searchParams.getAll('ranges');
      return json({ valueRanges: ranges.map(r => {
        const s = stores.find(x => `'${x.tab}'` === r);
        return { range: r, values: s ? fixture(s.code) : [] };
      }) });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });

  await page.addInitScript(() => localStorage.setItem('phlo.clientId', 'test.apps.googleusercontent.com'));
  await page.goto(base);
  await page.waitForFunction(() => window.google && window.google.accounts);
  await page.click('#signin');
  await page.waitForSelector('#build:not([disabled])');
  await page.fill('#date', '2026-10-20');
  await page.dispatchEvent('#date', 'change');
  await page.click('#build');
  await page.waitForSelector('#download:not([disabled])', { timeout: 15000 });

  const statuses = await page.$$eval('#stores li', lis => lis.map(li => li.querySelector('.code').textContent + '=' + li.querySelector('.status').textContent));
  const rowCount = await page.$$eval('#master tbody tr', trs => trs.length);
  const checks = await page.$$eval('#checks li', lis => lis.map(li => li.textContent));
  console.log('stores:', statuses.join(' '));
  console.log('rows:', rowCount);
  console.log('checks:\n  ' + checks.join('\n  '));

  // edit a cell and delete a row, then download
  const firstName = await page.locator('#master tbody tr').first().locator('td').nth(1);
  await firstName.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' EDITED');
  await page.locator('#master tbody tr').nth(1).locator('.del').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const out = path.join(require('os').tmpdir(), dl.suggestedFilename());
  await dl.saveAs(out);
  const got = XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(out)).Sheets.Sheet1, { header: 1 });
  console.log('download:', dl.suggestedFilename(), got.length - 1, 'rows; header', JSON.stringify(got[0]), '; first', JSON.stringify(got[1]));

  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'e2e-built.png'), fullPage: false });

  if (compareFile) {
    await page.setInputFiles('#compare-file', compareFile);
    await page.waitForSelector('#compare-out h2');
    console.log('compare:\n  ' + (await page.$eval('#compare-out', n => n.innerText)).split('\n').join('\n  '));
    if (shotDir) { await page.locator('#compare-card').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(shotDir, 'e2e-compare.png') }); }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (shotDir) await page.screenshot({ path: path.join(shotDir, 'e2e-phone.png') });
  console.log('phone horizontal overflow:', overflow);
  console.log('page errors:', errors.length ? errors : 'none');

  await browser.close();
  server.close();
  const ok = rowCount === 175 && got.length - 1 === 174 && String(got[1][0]).endsWith('EDITED') && !errors.length && !overflow;
  console.log(ok ? 'E2E OK' : 'E2E FAILED');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
