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
const server = require('./fake-apps-script')({ adminTokens: { fake: 'yourphlo@gmail.com' }, today: '2026-10-22', quo: true });

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
  function Thing(o){ this.o=o||{}; this.map=this.o.map; this.ls={}; } Thing.prototype = { setMap(m){this.map=m}, addListener(n,f){this.ls[n]=f}, setOptions(){}, setContent(){}, open(){}, close(){}, setIcon(i){this.icon=i}, setZIndex(){}, getPath(){ return { push(){} }; } };
  window.__markers = []; var M = function(o){ Thing.call(this,o); __markers.push(this); }; M.prototype = Thing.prototype;
  // 1px = 0.001 degrees; the map's top-left corner is (34.5, -118.5).
  g.LatLng = function(a,b){ this.a=a; this.b=b; }; g.LatLng.prototype = LL.prototype;
  g.OverlayView = function(){}; g.OverlayView.prototype = { setMap(){ this.ready = true; }, getProjection(){ return this.ready ? {
    fromLatLngToContainerPixel: function(ll){ return { x: (ll.lng() + 118.5) * 1000, y: (34.5 - ll.lat()) * 1000 }; },
    fromContainerPixelToLatLng: function(p){ return new LL(34.5 - p.y / 1000, -118.5 + p.x / 1000); } } : null; } };
  g.Map = function(div,o){ this.z=o.zoom; window.__maps=(window.__maps||0)+1; }; g.Map.prototype = { setOptions(){}, fitBounds(){}, setCenter(){}, setZoom(z){this.z=z}, getZoom(){return this.z}, panTo(){} };
  g.Marker = M; g.Polygon = Thing; g.Polyline = Thing; g.InfoWindow = Thing;
  g.SymbolPath = { CIRCLE: 0, BACKWARD_CLOSED_ARROW: 3 }; g.Point = function(){};
  g.LatLngBounds = function(){}; g.LatLngBounds.prototype = { extend(){}, getCenter(){ return {}; } };
  g.Geocoder = function(){}; g.Geocoder.prototype.geocode = function(req){
    var key = Object.keys(SPOTS).filter(function(k){ return req.address.toUpperCase().indexOf(k) >= 0; })[0];
    if (!key) return Promise.reject(Object.assign(new Error('ZERO_RESULTS'), { code: 'ZERO_RESULTS' }));
    // MIDDLE addresses come back as a partial match with Google's own spelling.
    var partial = key === 'MIDDLE';
    return Promise.resolve({ results: [{ formatted_address: partial ? '50 MIDDLE ROAD, TOWN, CA 91000, USA' : req.address.toUpperCase() + ', USA', partial_match: partial, types: ['street_address'], geometry: { location: new LL(SPOTS[key][0], SPOTS[key][1]) } }] });
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
  check(flags.length === 2, 'Check before sending lists only address problems (overlaps are not flagged): ' + JSON.stringify(flags));
  check(flags.some(t => t.includes('KAY,BO') && t.includes('uses the address it found: 50 MIDDLE ROAD') && t.includes('Pharmacy wrote: 50 MIDDLE RD TOWN CA 91000')), 'partial match uses Google\'s address and shows the pharmacy\'s');
  await office.click('.dp-route summary >> text=Ana Ruiz');
  const kayRow = await office.textContent('.dp-route[data-id="a"] tbody tr:has-text("KAY,BO")');
  check(kayRow.includes('50 MIDDLE ROAD, TOWN, CA 91000, USA') && kayRow.includes('Pharmacy wrote: 50 MIDDLE RD TOWN CA 91000'), 'route list shows both addresses');
  await office.click('.dp-route summary >> text=Ana Ruiz');
  const sums = await office.$$eval('.dp-route summary', l => l.map(x => x.textContent));
  console.log('     routes:', sums);
  check(sums[0].includes('Ana Ruiz') && sums[0].includes('3 stops') && sums[0].includes('8:00 AM'), 'Ana gets the west stops + overlap, starts 8:00');
  check(sums[1].includes('Bo Kim') && sums[1].includes('2 stops') && !sums[1].includes('estimated'), 'Bo (start found from his address) gets the east stops');
  check(routesCalls === 2, 'Google road times asked once per driver (' + routesCalls + ')');
  check(sums.some(t => t.includes('Not on a route') && t.includes('1 stop')), 'unfound stop listed as not on a route');
  // Max stops: with a max of 2, Ana's third stop goes off the routes with the reason; back to 50 restores it.
  await office.fill('#dp-max', '2'); await office.dispatchEvent('#dp-max', 'change');
  await office.waitForFunction(() => document.querySelector('.dp-route[data-id="_none"] summary').textContent.includes('2 stops'));
  check((await office.textContent('.dp-route[data-id="a"] summary')).includes('2 stops') && (await office.textContent('.dp-route[data-id="_none"]')).includes('every driver near it has the max stops'), 'max stops leaves the extra stop off with the reason');
  await office.fill('#dp-max', '50'); await office.dispatchEvent('#dp-max', 'change');
  await office.waitForFunction(() => document.querySelector('.dp-route[data-id="a"] summary').textContent.includes('3 stops'));
  check(true, 'max back to 50 puts it back');
  // Fix the address.
  await office.fill('#dp-flags li:has-text("NOE,CY") .dp-fix input', '60 WILLOW AVE TOWN CA 91000');
  await office.click('#dp-flags li:has-text("NOE,CY") .dp-fix .btn');
  await office.waitForFunction(() => ![...document.querySelectorAll('#dp-flags li')].some(li => li.textContent.includes('NOE,CY')));
  check((await office.$$eval('.dp-route summary', l => l.map(x => x.textContent)))[0].includes('4 stops'), 'fixed address joins Ana\'s route');
  // Move a stop to Bo.
  await office.click('.dp-route summary >> text=Ana Ruiz');
  await office.selectOption('.dp-route[data-id="a"] tbody tr:first-child select[aria-label^="Driver for"]', 'b');
  await office.waitForFunction(() => document.querySelector('.dp-route[data-id="b"] summary').textContent.includes('3 stops'));
  check(true, 'moved a stop to Bo');
  // Select tool: loop around Bo's two east stops (EAST -117.85, ELM -117.88 => x 620-650, y 450-460) and give them to Ana.
  await office.click('[data-dptool="select"]');
  check(await office.isVisible('#dp-sel-help') && await office.isVisible('#dp-draw'), 'select mode shows help and the drawing layer');
  await office.locator('#dp-map-card').evaluate(e => e.scrollIntoView({ block: 'start' }));
  const mb = await office.locator('#dp-draw').boundingBox();
  const loop = [[600, 430], [680, 430], [680, 480], [600, 480], [600, 432]];
  await office.mouse.move(mb.x + loop[0][0], mb.y + loop[0][1]); await office.mouse.down();
  for (const [x, y] of loop.slice(1)) await office.mouse.move(mb.x + x, mb.y + y, { steps: 5 });
  await office.mouse.up();
  const mb2 = await office.locator('#dp-draw').boundingBox();
  check(Math.abs(mb2.y - mb.y) < 1, 'map does not move when stops get selected (' + (mb2.y - mb.y) + 'px)');
  check((await office.textContent('#dp-sel-count')).startsWith('2 stops selected (Bo)'), 'loop selects 2 stops: ' + await office.textContent('#dp-sel-count'));
  // Tap Ana's WEST stop (-118.15, 34.05 => x 350, y 450) to add it, then tap again to remove it.
  await office.mouse.click(mb.x + 352, mb.y + 451);
  check((await office.textContent('#dp-sel-count')).startsWith('3 stops selected'), 'tap adds a stop');
  await office.mouse.click(mb.x + 352, mb.y + 451);
  check((await office.textContent('#dp-sel-count')).startsWith('2 stops selected'), 'tap again removes it');
  check(await office.evaluate(() => __markers.filter(m => m.map && m.icon && m.icon.strokeColor === '#111111').length) === 2, 'selected stops are highlighted');
  if (shots) await office.locator('#dp-map-card').screenshot({ path: path.join(shots, 'select.png') });
  check(await office.inputValue('#dp-sel-driver') === 'a', 'driver list starts on a driver who does not have these stops');
  await office.selectOption('#dp-sel-driver', 'a');
  await office.click('#dp-sel-apply');
  await office.waitForFunction(() => document.querySelector('.dp-route[data-id="b"] summary').textContent.includes('1 stop'));
  check((await office.textContent('.dp-route[data-id="a"] summary')).includes('5 stops') && await office.isHidden('#dp-sel'), 'Move stops gives both to Ana and clears the selection');
  // And back to Bo.
  await office.mouse.move(mb.x + loop[0][0], mb.y + loop[0][1]); await office.mouse.down();
  for (const [x, y] of loop.slice(1)) await office.mouse.move(mb.x + x, mb.y + y, { steps: 5 });
  await office.mouse.up();
  await office.selectOption('#dp-sel-driver', 'b');
  await office.click('#dp-sel-apply');
  await office.waitForFunction(() => document.querySelector('.dp-route[data-id="b"] summary').textContent.includes('3 stops'));
  check(true, 'moved them back to Bo');
  await office.click('[data-dptool="move"]');
  check(await office.isHidden('#dp-draw'), 'Move mode hides the drawing layer');
  // Print.
  await office.evaluate(() => { window.print = () => { window.__printed = document.querySelectorAll('#print-area .print-page').length; }; });
  await office.click('#dp-print');
  check(await office.evaluate(() => window.__printed) === 2, 'print makes one page per driver');
  check((await office.textContent('#print-area')).includes('Pharmacy wrote: 50 MIDDLE RD TOWN CA 91000'), 'printout keeps the pharmacy\'s address');
  if (shots) await office.screenshot({ path: path.join(shots, 'dispatch.png'), fullPage: true });
  // Patient texts: DOE gets texts in Spanish; BP pharmacy gets a sign-in PIN.
  await office.evaluate(() => { document.querySelector('.dp-route[data-id="a"]').open = true; });
  await office.fill('.dp-route[data-id="a"] tr:has-text("DOE,JANE") .dp-phone', '626-555-01');
  await office.dispatchEvent('.dp-route[data-id="a"] tr:has-text("DOE,JANE") .dp-phone', 'change');
  check(await office.getAttribute('.dp-route[data-id="a"] tr:has-text("DOE,JANE") .dp-phone', 'aria-invalid') === 'true', 'texts: a short mobile number is marked');
  await office.fill('.dp-route[data-id="a"] tr:has-text("DOE,JANE") .dp-phone', '(626) 555-0101');
  await office.dispatchEvent('.dp-route[data-id="a"] tr:has-text("DOE,JANE") .dp-phone', 'change');
  await office.selectOption('.dp-route[data-id="a"] tr:has-text("DOE,JANE") select[aria-label^="Text language"]', 'es');
  await office.click('#dp-text-card summary');
  await office.waitForSelector('#ts-rx tr[data-code="BP"]');
  check((await office.textContent('#ts-status')).includes('Texting is on'), 'texts: settings say texting is on');
  await office.fill('#ts-rx tr[data-code="BP"] [name="phone"]', '626 555 0300');
  await office.fill('#ts-rx tr[data-code="BP"] [name="pin"]', '2468');
  await office.click('#ts-save');
  await office.waitForFunction(() => (document.querySelector('#ts-rx tr[data-code="BP"] [name="pin"]') || {}).placeholder === 'New PIN (has one)');
  check(JSON.parse(server.props.rxAccounts).bp.hash.length === 64, 'texts: BP pharmacy PIN saved on the server');
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
  const kay = await phone.textContent('.dv-stop:has-text("KAY,BO")');
  check(kay.includes('50 MIDDLE ROAD, TOWN, CA 91000, USA') && kay.includes('Pharmacy wrote: 50 MIDDLE RD TOWN CA 91000'), 'driver gets Google\'s address plus the pharmacy\'s');
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

  /* ---- patient texts ---- */
  check(!Object.values(server.files).some(f => f.name.startsWith('routes-') && String(f.content).includes('5550101')), 'texts: the phone number is not in the routes file');
  await office.click('#dp-live li:has-text("DOE,JANE") .linkish:text-matches("Text (now|again)")');
  await office.waitForFunction(() => document.querySelector('#dp-live').textContent.includes('Texted '));
  const toDoe = server.sms.filter(m => m.to === '+16265550101');
  check(toDoe.length >= 1 && toDoe[0].body.startsWith('Entrega PHLO'), 'texts: DOE texted in Spanish');
  const token = toDoe[0].body.match(/#t=(\w+)/)[1];
  // The patient opens the link and asks to leave it at the front door.
  const perrors = [];
  const patient = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await setup(patient, perrors);
  await patient.goto(base + '#t=' + token);
  await patient.waitForSelector('.pt-option');
  check((await patient.textContent('#pt-title')) === 'Su entrega de farmacia' && (await patient.textContent('#pt-when')).startsWith('Entrega el jueves'), 'texts: reply page in Spanish');
  check(await patient.isHidden('#locked') && await patient.isHidden('#tabs') && !(await patient.textContent('body')).includes('DOE'), 'texts: reply page shows no sign-in, tabs or name');
  await patient.click('.pt-option[data-choice="door"]');
  check((await patient.textContent('#pt-body')).includes('Su farmacia debe aprobarlo primero'), 'texts: door choice says the pharmacy must approve');
  await patient.click('#pt-body button[type=submit]');
  await patient.waitForSelector('#pt-status:not([hidden])');
  check((await patient.textContent('#pt-status')).includes('Esperando la aprobación de su farmacia'), 'texts: patient sees it waits for the pharmacy: ' + await patient.textContent('#pt-status'));
  await patient.selectOption('#pt-lang', 'zh');
  check((await patient.textContent('#pt-title')) === '您的药房送货', 'texts: patient switches to Chinese');
  if (shots) await patient.screenshot({ path: path.join(shots, 'patient.png'), fullPage: true });
  // The pharmacy signs in and approves.
  const rxerrors = [];
  const rx = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await setup(rx, rxerrors);
  await rx.goto(base);
  await rx.fill('#rx-login [name="store"]', 'bp');
  await rx.fill('#rx-login [name="pin"]', '2468');
  await rx.click('#rx-login button[type=submit]');
  await rx.waitForSelector('#rx-stops li');
  const rxTxt = await rx.textContent('#rx-stops');
  check(rxTxt.includes('DOE,JANE') && rxTxt.includes('Patient: Leave at front door') && rxTxt.includes('Needs your OK'), 'texts: pharmacy sees the request');
  check((await rx.textContent('#rx-count')).includes('1 need your OK') && await rx.isHidden('#tabs'), 'texts: pharmacy page, no office tabs');
  if (shots) await rx.screenshot({ path: path.join(shots, 'pharmacy.png'), fullPage: true });
  await rx.click('#rx-stops li:has-text("DOE,JANE") .btn:has-text("Approve / decline")');
  await rx.click('#ask-approve [data-ok="1"]');
  check(await rx.isVisible('#ask-approve .form-errors li:has-text("name and position")'), 'texts: approval needs name + position');
  await rx.fill('#ask-approve [name="by"]', 'Jane Kim');
  await rx.fill('#ask-approve [name="position"]', 'Pharmacist');
  await rx.click('#ask-approve [data-ok="1"]');
  await rx.waitForFunction(() => document.querySelector('#rx-stops').textContent.includes('OK\'d by Jane Kim, Pharmacist'));
  check(server.sms.some(m => m.to === '+16265550101' && m.body.startsWith('PHLO：您的送货有新消息')), 'texts: patient told there is an update, in the language they picked (Chinese)');
  // The office asks Ana to bring KAY back.
  await office.click('#dp-live-refresh');
  await office.waitForFunction(() => document.querySelector('#dp-live').textContent.includes('OK\'d by Jane Kim'));
  await office.click('#dp-live li:has-text("KAY,BO") .linkish:has-text("Message driver")');
  await office.click('#ask-message [data-send]');
  check(await office.isVisible('#ask-message .form-errors li:has-text("Pick a reason")'), 'texts: message needs a reason');
  await office.check('#ask-message input[value="pickup"]');
  await office.click('#ask-message [data-send]');
  await office.waitForFunction(() => document.querySelector('#dp-live').textContent.includes('To driver: Please RTS to RX [1000005, KAY,BO]: PT will pick up @ RX instead'));
  check(server.sms.some(m => m.to === '+15555550100' && /^PHLO: new message for stop \d+\. Open the PHLO app\.$/.test(m.body)), 'texts: driver texted about the message, with no details');
  // Ana's phone: the message, the approval, and a photo is required.
  await phone.click('#dv-refresh');
  await phone.waitForSelector('#dv-msgs:not([hidden])');
  check((await phone.textContent('#dv-msgs')).includes('Please RTS to RX [1000005, KAY,BO]'), 'texts: driver sees the message');
  await phone.click('#dv-msg-list .btn:has-text("Got it")');
  await phone.waitForFunction(() => !document.querySelector('#dv-msg-list .btn'));
  check((await phone.textContent('.dv-stop:has-text("DOE,JANE")')).includes('OK\'d by Jane Kim, Pharmacist'), 'texts: driver sees the pharmacy OK on the stop');
  await phone.click('.dv-stop:has-text("DOE,JANE")');
  check(await phone.isChecked('#dv-form input[value="door"]') && await phone.isChecked('#dv-form input[value="approved"]') &&
    (await phone.inputValue('#dv-form [name="approvedBy"]')) === 'Jane Kim (Pharmacist)', 'texts: form starts as front door, approved by the pharmacist');
  if (await phone.isVisible('#dv-copay-field')) await phone.fill('#dv-form [name="copayCollected"]', '5.00');
  await phone.click('#dv-save');
  check(await phone.isVisible('#dv-errors li:has-text("photo is required")'), 'texts: photo required');
  await phone.setInputFiles('#dv-photo', { name: 'p.png', mimeType: 'image/png', buffer: png });
  await phone.waitForSelector('#dv-photo-preview:not([hidden])');
  await phone.click('#dv-save');
  await phone.waitForFunction(() => !document.getElementById('dv-stop').open);
  check((await phone.textContent('#dv-sub')).includes('2 of 3 done'), 'texts: saved with the photo');
  await rx.click('#rx-refresh');
  await rx.waitForSelector('#rx-stops li:has-text("DOE,JANE") .linkish:has-text("Photo")');
  await rx.click('#rx-stops li:has-text("DOE,JANE") .linkish:has-text("Photo")');
  await rx.waitForFunction(() => (document.getElementById('img-full').src || '').startsWith('data:image/'));
  check(true, 'texts: pharmacy sees the drop-off photo');
  check(!perrors.length && !rxerrors.length, 'no page errors (patient, pharmacy) ' + JSON.stringify(perrors.concat(rxerrors)));
  await office.click('#dp-live-refresh');
  await office.waitForTimeout(500);
  if (shots) await office.screenshot({ path: path.join(shots, 'live.png'), fullPage: true });

  /* ---- a note that names a driver ---- */
  const nerrors = [];
  const office2 = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await setup(office2, nerrors);
  await office2.addInitScript(d => { if (!localStorage.getItem('phlo.drivers')) localStorage.setItem('phlo.drivers', d); }, JSON.stringify(DRIVERS));
  await office2.goto(base);
  await office2.click('#signin-main');
  await office2.waitForSelector('#tabs:not([hidden])');
  await office2.fill('#date', '2026-10-22');
  // ROE is in Ana's area, but the pharmacy wrote that only Bo can deliver it.
  await office2.fill('.paste-text', PASTE.replace('ROE,ANN - 20 WILLOW AVE TOWN CA 91000\t\t\t\t\t', 'ROE,ANN - 20 WILLOW AVE TOWN CA 91000\t\t\t\tONLY BO CAN DELIVER\t'));
  await office2.click('#build');
  await office2.waitForFunction(() => document.querySelectorAll('#master tbody tr').length === 6);
  check((await office2.textContent('#master')).includes('ONLY BO CAN DELIVER'), 'the note is in the master');
  await office2.click('.tab[data-view="dispatch"]');
  await office2.click('#dp-plan');
  await office2.waitForSelector('#dp-routes-card:not([hidden])');
  await office2.click('.dp-route summary >> text=Bo Kim');
  const boRows = await office2.textContent('.dp-route[data-id="b"] tbody');
  check(boRows.includes('ROE,ANN') && boRows.includes('Only Bo Kim (note)'), 'stop whose note names Bo goes to Bo, with a tag');
  check(!(await office2.textContent('.dp-route[data-id="a"]')).includes('ROE,ANN'), 'and not to Ana, whose area it is in');
  check(!nerrors.length, 'no page errors (note run) ' + JSON.stringify(nerrors));

  check(!errors.length && !derrors.length, 'no page errors ' + JSON.stringify(errors.concat(derrors)));
  await browser.close(); web.close();
  console.log(failures ? failures + ' failure(s)' : 'dispatch e2e: all good');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
