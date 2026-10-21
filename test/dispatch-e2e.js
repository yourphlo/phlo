// End-to-end check of Dispatch + the driver app in Chromium, with Google and the dispatch server faked
// (the server is the real apps-script-dispatch/Server.gs running on test/fake-apps-script.js).
//   node test/dispatch-e2e.js [screenshot-dir]      (needs playwright)
const fs = require('fs');
const path = require('path');
const http = require('http');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  try { ({ chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright')); } catch (e2) { console.log('dispatch e2e skipped (needs playwright)'); process.exit(0); }
}
const root = path.join(__dirname, '..');
const shots = process.argv[2];
const DISPATCH = 'https://script.google.com/macros/s/fake/exec';
const server = require('./fake-apps-script')({ adminTokens: { fake: 'yourphlo@gmail.com' }, today: '2026-10-22' });

const web = http.createServer((req, res) => {
  const f = path.join(root, 'web', decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(f);
  if (f.endsWith('config.js')) body = String(body).replace(/dispatchUrl: '[^']*'/, `dispatchUrl: '${DISPATCH}'`);
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' });
  res.end(body);
});

const GSI = `window.google = window.google || {}; google.accounts = { oauth2: {
  initTokenClient: (o) => ({ requestAccessToken: () => setTimeout(() => o.callback({ access_token: 'fake', expires_in: 3600 }), 10) }),
  revoke: (t, cb) => cb && cb() } };`;
// Fake Google Maps: addresses map to points by street name; enough of Map/Marker/etc for the page.
const MAPS = `(function(){
  window.google = window.google || {}; var g = google.maps = {};
  var SPOTS = { 'WEST': [34.05, -118.15], 'WILLOW': [34.06, -118.12], 'EAST': [34.05, -117.85], 'ELM': [34.04, -117.88], 'MIDDLE': [34.05, -118.02] };
  function LL(a,b){ this.a=a; this.b=b; } LL.prototype.lat=function(){return this.a}; LL.prototype.lng=function(){return this.b};
  function Thing(o){ this.o=o||{}; this.map=this.o.map; } Thing.prototype = { setMap(m){this.map=m}, addListener(){}, setOptions(){}, setContent(){}, open(){}, getPath(){ return { push(){} }; } };
  g.Map = function(div,o){ this.z=o.zoom; window.__maps=(window.__maps||0)+1; }; g.Map.prototype = { setOptions(){}, fitBounds(){}, setCenter(){}, setZoom(z){this.z=z}, getZoom(){return this.z}, panTo(){} };
  g.Marker = Thing; g.Polygon = Thing; g.Polyline = Thing; g.InfoWindow = Thing; g.OverlayView = function(){}; g.OverlayView.prototype = { setMap(){}, getProjection(){ return null; } };
  g.SymbolPath = { CIRCLE: 0, BACKWARD_CLOSED_ARROW: 3 }; g.Point = function(){};
  g.LatLngBounds = function(){}; g.LatLngBounds.prototype = { extend(){}, getCenter(){ return {}; } };
  g.Geocoder = function(){}; g.Geocoder.prototype.geocode = function(req){
    var key = Object.keys(SPOTS).filter(function(k){ return req.address.toUpperCase().indexOf(k) >= 0; })[0];
    if (!key) return Promise.reject(Object.assign(new Error('ZERO_RESULTS'), { code: 'ZERO_RESULTS' }));
    return Promise.resolve({ results: [{ formatted_address: req.address.toUpperCase() + ', USA', partial_match: false, types: ['street_address'], geometry: { location: new LL(SPOTS[key][0], SPOTS[key][1]) } }] });
  };
  g.importLibrary = function(){ return Promise.resolve(g); };
  setTimeout(function(){ window.__phloMapsLoaded(); }, 0);
})();`;

const sq = (lng1, lng2) => [[34, lng1], [34, lng2], [34.1, lng2], [34.1, lng1]];
const DRIVERS = { updatedAt: '2026-10-01', drivers: [
  { id: 'a', name: 'Ana Ruiz', startAddress: '1 West St', startPin: { address: '1 West St', lat: 34.07, lng: -118.18 }, availableFrom: '08:00', lunchFrom: '12:00', lunchTo: '12:30', areas: [sq(-118.2, -118.0)], mobile: '5555550100' },
  { id: 'b', name: 'Bo Kim', startAddress: '9 East St', areas: [sq(-118.05, -117.8)], capacity: 5 }] };
const PASTE = [
  ['', '', '1000001', 'DOE,JANE - 10 WEST ST TOWN CA 91000', '', '', '', 'FRIDGE', '5'],
  ['', '', '1000002', 'ROE,ANN - 20 WILLOW AVE TOWN CA 91000', '', '', '', '', ''],
  ['', '', '1000003', 'POE,ED - 30 EAST BLVD TOWN CA 91000', '', '', '', '', '2.50'],
  ['', '', '1000004', 'LEE,AL - 40 ELM DR TOWN CA 91000', '', '', '', '', ''],
  ['', '', '1000005', 'KAY,BO - 50 MIDDLE RD TOWN CA 91000', '', '', '', '', ''],
  ['', '', '1000006', 'NOE,CY - 60 NOWHERE LN TOWN CA 91000', '', '', '', '', '']].map(r => r.join('\t')).join('\n');

let routesCalls = 0, failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log('FAIL', msg); } else console.log('ok  ', msg); };

async function setup(page, errors) {
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route(/fonts\./, r => r.abort());
  await page.route(/cdnjs.*xlsx/, r => r.fulfill({ contentType: 'text/javascript', body: 'window.XLSX={utils:{}}' }));
  await page.route(/gsi\/client/, r => r.fulfill({ contentType: 'text/javascript', body: GSI }));
  await page.route(/maps\.googleapis\.com/, r => r.fulfill({ contentType: 'text/javascript', body: MAPS }));
  await page.route(/routes\.googleapis\.com/, r => {
    routesCalls++;
    const b = JSON.parse(r.request().postData());
    const n = (b.intermediates || []).length;
    const order = [...Array(n).keys()].reverse();
    r.fulfill({ json: { routes: [{ legs: Array.from({ length: n + 1 }, () => ({ duration: '600s', distanceMeters: 5000 })),
      optimizedIntermediateWaypointIndex: b.optimizeWaypointOrder ? order : undefined, polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' } }] } });
  });
  await page.route(/googleapis\.com\/(drive|upload)/, r => {
    const u = r.request().url();
    if (u.includes('/about')) return r.fulfill({ json: { user: { emailAddress: 'yourphlo@gmail.com' } } });
    if (u.includes('/upload/')) return r.fulfill({ json: { id: 'drv1' } });
    return r.fulfill({ json: { files: [] } });
  });
  await page.route(/sheets\.googleapis/, r => r.fulfill({ status: 404, json: {} }));
  await page.route(DISPATCH, r => r.fulfill({ contentType: 'application/json', body: JSON.stringify(server.post(r.request().postData())) }));
}

(async () => {
  await new Promise(r => web.listen(0, r));
  const base = `http://127.0.0.1:${web.address().port}/`;
  const browser = await chromium.launch();

  /* ---- office ---- */
  const errors = [];
  const office = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await setup(office, errors);
  await office.addInitScript(d => { if (!localStorage.getItem('phlo.drivers')) localStorage.setItem('phlo.drivers', d); }, JSON.stringify(DRIVERS));
  await office.goto(base);
  await office.click('#signin-main');
  await office.waitForSelector('#tabs:not([hidden])');
  await office.fill('#date', '2026-10-22');
  await office.fill('.paste-text', PASTE);
  await office.click('#build');
  await office.waitForFunction(() => document.querySelectorAll('#master tbody tr').length === 6);
  // Give Ana a PIN.
  await office.click('.tab[data-view="drivers"]');
  await office.click('.dname:has-text("Ana Ruiz")');
  await office.fill('#driver-form [name="pin"]', '12');
  await office.click('#driver-form button[type=submit]');
  check(await office.isVisible('#driver-errors li:has-text("4 to 6 digits")'), 'short PIN refused');
  await office.fill('#driver-form [name="pin"]', '4321');
  await office.click('#driver-form button[type=submit]');
  await office.waitForSelector('#driver-form-card[hidden]', { state: 'attached' });
  await office.waitForTimeout(1200);
  check(JSON.parse(server.props.accounts || '{}').ana && JSON.parse(server.props.accounts).ana.hash.length === 64, 'driver logins sent to the server (ana)');
  check((await office.textContent('#drivers')).includes('App ana'), 'driver list shows app username');
  // Random PINs for everyone still without one (Bo).
  await office.click('#set-pins');
  check((await office.textContent('#pins-missing-label')).includes('(1)'), 'one driver without a PIN');
  await office.click('#pins-make');
  await office.waitForSelector('#pins-result:not([hidden])');
  const pinRows = await office.$$eval('#pins-rows tr', l => l.map(r => [...r.children].map(td => td.textContent)));
  check(pinRows.length === 1 && pinRows[0][0] === 'Bo Kim' && pinRows[0][1] === 'bo' && /^\d{6}$/.test(pinRows[0][2]), 'Bo got a 6-digit PIN ' + JSON.stringify(pinRows));
  await office.click('#pins-result button:has-text("Done")');
  await office.waitForTimeout(1200);
  const bo = server.post({ action: 'driver.login', username: 'bo', pin: pinRows[0][2] });
  check(bo.ok, 'Bo can sign in with the new PIN');

  await office.click('.tab[data-view="dispatch"]');
  check((await office.textContent('#dp-summary')).includes('6 stops'), 'dispatch summary: ' + await office.textContent('#dp-summary'));
  await office.click('#dp-plan');
  await office.waitForSelector('#dp-routes-card:not([hidden])');
  const flags = await office.$$eval('#dp-flags li', l => l.map(x => x.textContent));
  check(flags.some(t => t.includes('NOE,CY') && t.includes('not found')), 'flag: address not found');
  check(flags.some(t => t.includes('KAY,BO') && t.includes('more than one')), 'flag: overlap');
  const sums = await office.$$eval('.dp-route summary', l => l.map(x => x.textContent));
  console.log('     routes:', sums);
  check(sums[0].includes('Ana Ruiz') && sums[0].includes('3 stops') && sums[0].includes('8:00 AM'), 'Ana gets the west stops + overlap, starts 8:00');
  check(sums[1].includes('Bo Kim') && sums[1].includes('2 stops') && !sums[1].includes('estimated'), 'Bo (start found from his address) gets the east stops');
  check(routesCalls === 2, 'Google road times asked once per driver (' + routesCalls + ')');
  check(sums.some(t => t.includes('Not on a route') && t.includes('1 stop')), 'unfound stop listed as not on a route');
  // Fix the address.
  await office.fill('.dp-fix input', '60 WILLOW AVE TOWN CA 91000');
  await office.click('.dp-fix .btn');
  await office.waitForFunction(() => !document.querySelector('.dp-fix'));
  check((await office.$$eval('.dp-route summary', l => l.map(x => x.textContent)))[0].includes('4 stops'), 'fixed address joins Ana\'s route');
  // Move a stop to Bo.
  await office.click('.dp-route summary >> text=Ana Ruiz');
  await office.selectOption('.dp-route[data-id="a"] tbody tr:first-child select', 'b');
  await office.waitForFunction(() => document.querySelector('.dp-route[data-id="b"] summary').textContent.includes('3 stops'));
  check(true, 'moved a stop to Bo');
  // Print.
  await office.evaluate(() => { window.print = () => { window.__printed = document.querySelectorAll('#print-area .print-page').length; }; });
  await office.click('#dp-print');
  check(await office.evaluate(() => window.__printed) === 2, 'print makes one page per driver');
  if (shots) await office.screenshot({ path: path.join(shots, 'dispatch.png'), fullPage: true });
  // Send.
  await office.click('#dp-send');
  await office.waitForFunction(() => document.querySelector('#dp-live-count').textContent.includes('0 of 6'));
  check(true, 'routes sent; live shows 0 of 6 done');

  /* ---- driver phone ---- */
  const derrors = [];
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await setup(phone, derrors);
  await phone.goto(base);
  await phone.fill('#driver-login [name="username"]', 'Ana');
  await phone.fill('#driver-login [name="pin"]', '0000');
  await phone.click('#driver-login button[type=submit]');
  await phone.waitForSelector('#driver-login-error:not([hidden])');
  check((await phone.textContent('#driver-login-error')).includes('Wrong'), 'wrong PIN refused');
  await phone.fill('#driver-login [name="pin"]', '4321');
  await phone.click('#driver-login button[type=submit]');
  await phone.waitForSelector('.dv-stop');
  const dstops = await phone.$$eval('.dv-stop .nm', l => l.map(x => x.textContent));
  check(dstops.length === 3 && !dstops.some(t => /POE|LEE/.test(t)), 'Ana sees only her 3 stops: ' + dstops.join(' | '));
  check(await phone.isHidden('#tabs') && await phone.isHidden('#view-master'), 'driver sees no office tabs');
  if (shots) await phone.screenshot({ path: path.join(shots, 'driver-list.png'), fullPage: true });
  await phone.click('.dv-stop.next');
  await phone.check('#dv-form input[value="approved"]');
  await phone.click('#dv-save');
  check(await phone.isVisible('#dv-errors li:has-text("pharmacy staff")'), 'approved needs staff name');
  await phone.fill('#dv-form [name="approvedBy"]', 'Kim at BP');
  await phone.check('#dv-form input[value="door"]');
  // signature
  const c = await phone.locator('#dv-sig').boundingBox();
  await phone.mouse.move(c.x + 20, c.y + 40); await phone.mouse.down(); await phone.mouse.move(c.x + 150, c.y + 90, { steps: 6 }); await phone.mouse.up();
  // photo: a small generated PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await phone.setInputFiles('#dv-photo', { name: 'p.png', mimeType: 'image/png', buffer: png });
  await phone.waitForSelector('#dv-photo-preview:not([hidden])');
  if (await phone.isVisible('#dv-copay-field')) await phone.fill('#dv-form [name="copayCollected"]', '5.00');
  if (shots) await phone.screenshot({ path: path.join(shots, 'driver-stop.png'), fullPage: true });
  await phone.click('#dv-save');
  await phone.waitForFunction(() => !document.getElementById('dv-stop').open);
  check((await phone.textContent('#dv-sub')).includes('1 of 3 done'), 'driver progress 1 of 3');

  /* ---- office sees it ---- */
  await office.click('#dp-live-refresh');
  await office.waitForFunction(() => document.querySelector('#dp-live-count').textContent.includes('1 of 6'));
  const liveTxt = await office.textContent('#dp-live');
  check(liveTxt.includes('Delivered') && liveTxt.includes('front door, approved by Kim at BP'), 'office sees outcome + approver');
  await office.click('#dp-live .linkish:has-text("Signature")');
  await office.waitForFunction(() => (document.getElementById('img-full').src || '').startsWith('data:image/png'));
  check(true, 'office opens the signature');
  await office.keyboard.press('Escape');
  if (shots) await office.screenshot({ path: path.join(shots, 'live.png'), fullPage: true });

  check(!errors.length && !derrors.length, 'no page errors ' + JSON.stringify(errors.concat(derrors)));
  await browser.close(); web.close();
  console.log(failures ? failures + ' failure(s)' : 'dispatch e2e: all good');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
