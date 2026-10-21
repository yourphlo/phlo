# PHLO master builder

Builds the daily PHLO upload sheet (`NAME | ADDRESS | NOTES | NOTES 2`) from every
pharmacy's delivery Google Sheet.

Two ways to run it (same logic, same results):

- **Web app** (`web/`) - a page published on GitHub Pages. Sign in with Google, pick the
  delivery date, review the checks, fix anything in the table, download the `.xlsx`.
  It can also check a finished upload file against the store sheets.
- **Google Sheets menu** (`apps-script/`) - a PHLO menu inside a Google Sheet.

## Web app

### Daily use

1. Open the page and **Sign in with Google** as yourphlo@gmail.com. Nothing else on the page shows
   until you do, and any other Google account is signed straight back out (the allowed accounts are
   `allowedEmails` in `web/config.js`).
2. Pick the **delivery date** (defaults to tomorrow) and click **Build master**.
   **BP from Outlook:** if BP's sheet isn't in your Google Drive, open it from Outlook, select the
   rows on its day tab (Ctrl+A), copy, and paste into the **BP** box under **Paste cells** before
   clicking Build master. Every pasted row goes on this delivery, so paste just the day(s) you want
   (Saturday's and Sunday's tabs for a Monday). The app finds the RX number column by itself, so the
   copy doesn't have to start at column A. A full box replaces the Google Drive search for BP; leave it
   empty to use Drive as before. Pasted cells are never saved and disappear when you sign out or reload.
3. Each store shows how many rows it gave and when its sheet was last updated. A store with
   0 rows or "no file found" probably hasn't entered its list yet.
4. Go through **Check before uploading**: missing RX numbers, stray letters in RX numbers,
   ZIP codes that aren't 5 digits, two addresses in one cell, duplicate RX numbers, and the
   same address on two rows. Click a check to jump to the row.
5. Click any cell to fix it, or × to delete a row. Then **Download .xlsx**
   (saved as `10.20.26_UPLOAD.xlsx`).
6. Optional: drop your hand-edited upload file into **Check a finished file** to see any RX
   number missing from it, any that isn't in the store sheets, and typos.

### Drivers

The **Drivers** tab keeps a profile for each driver: name and start address (required), end
address, availability hours, mobile number, capacity, types (case sensitive, e.g. `FRIDGE`),
driving speed (SLOW 10% / NORMAL 100% / FAST 190%) and lunch break.

Availability can be just a start time, just an end time, both, or empty. Lunch break needs both.

1. Click **Add driver**, fill in the form, **Save driver**. Click a name later to edit it, × to delete.
   In the address boxes, start typing and pick the address from the Google suggestions: that
   fills in the full address and pins its exact spot on Google Maps (saved with the profile, ready
   for route planning). Each address in the list has a **Map** link; "Map (not pinned)" means the
   address was typed by hand, so open the driver and pick it from the suggestions. Suggestions need
   the Google Maps key (setup step 4 below); without it the boxes are plain text.
2. Pick the **Working on** date (defaults to tomorrow) and tick who is driving that day. A new
   date starts with the same drivers as the last day you set.
3. **Download drivers .xlsx** saves the working drivers (`10.21.26_DRIVERS.xlsx`), one row per
   driver with the fields above.

**Coverage map** (bottom of the Drivers tab): shows the area each driver covers, one colour per driver.

1. Click a driver's name above the map, then **Pencil**.
2. Hold the mouse button (or your finger) down and draw around their area; let go to close the shape.
   Draw as many areas per driver as you need. The scroll wheel still zooms while the pencil is on.
3. **Move** pans and zooms the map, **Erase** removes the area you click, **Undo** takes back the last
   change, **Clear driver** removes all of that driver's areas, **Fit all** zooms to every area.
4. **Download areas** saves them as a `.geojson` file (e.g. `10.21.26_DRIVER_AREAS.geojson`) you can
   share or open in geojson.io.

Areas are saved inside each driver's profile, so they sync to your Google account like the rest.
The map uses the same Google Maps key as the address suggestions.

When you're signed in, profiles are saved to your own Google account (a hidden app folder in
your Google Drive), so they show up on any computer once you sign in with the same account.
Signed out, they are kept in that browser only and uploaded the next time you sign in.

**App username and App PIN** (in the driver form): what the driver types to sign in to the driver
app. The username is the first name unless you type another one; the PIN is 4 to 6 digits (6 is
safer). The PIN is stored only scrambled, so it can't be shown again: type a new one to change it.

### Dispatch

The **Dispatch** tab turns the built master into one route per driver working that day (the ticks
on the Drivers tab for the delivery date) and sends each driver their route.

1. Build the master on the Master tab, then open **Dispatch** and click **Plan routes**. PHLO finds
   every address on Google Maps and splits the stops between the drivers: a driver only gets stops
   inside their coverage area or up to 2 miles outside it, and a stop goes to the driver whose route
   already passes closest to it, so routes stay in one piece and don't overlap. (Drivers with no area
   drawn only get stops no area reaches; a FRIDGE stop only goes to a driver with that type.) It then
   orders each route by real driving time from the driver's start address (and back to their end
   address, if they have one). Arrival times use the driver's hours, lunch break and speed, plus
   **Minutes per stop**. **Start time** is used for drivers without an availability start.
2. **Check before sending** lists address problems only: stop addresses Google can't find (fix the
   address and click **Find**), stop addresses Google only found part of, and driver start or end
   addresses it can't find (fix those on the Drivers tab). When Google only found part of an
   address, the route uses the address Google found, and the pharmacy's original stays with the stop
   ("Pharmacy wrote: ...") on the route list, the printout and the driver app, in case Google got it
   wrong. Retype it and click **Find** to use another address. Click a stop to see it on the map. Whether each driver's
   route fits them is up to you: a stop in two drivers' areas or in nobody's area goes to the nearest
   driver, and each route's heading shows when it is over capacity or runs past the driver's hours.
3. To move a stop, pick another driver in its **Driver** list (in the route list or by clicking it on
   the map). Both routes are re-planned.
   To move many at once, click **Select stops** above the map, draw a loop around the stops (or tap
   stops to add or remove them), pick a driver and click **Move stops**. **Move** goes back to
   panning the map; **Clear** (or Esc) empties the selection.
4. **Print routes** prints one sheet per driver with boxes for the outcome, copay and a signature.
5. **Send to drivers** sends the routes to the driver app. Sending again replaces the routes;
   anything drivers already recorded is kept.
6. **Deliveries** at the bottom shows each driver's progress live (refreshes every minute): delivered
   or not, how it was left, who approved it, copay collected, notes, and the photo and signature.

### Driver app

Drivers open the same page on their phone (`https://yourphlo.github.io/phlo/`) and use
**Driver sign-in** with their app username and PIN. They see only their own route: the stops in
order with arrival times, notes and copay due, and a button that opens Google Maps directions to
the next stop. At each stop they tap the stop and record:

- **Delivered** or **Not delivered** (a reason is required),
- **Left in mailbox**, **Left at front door** and/or **Approved by pharmacy staff** (with the name),
- **Copay collected**, a **photo** and the patient's **signature**, and a note.

They stay signed in on that phone for 16 hours. Five wrong PINs lock that username for 15 minutes.
Removing a driver or their PIN signs them out.

### Patient data

The page reads the store sheets with your own Google sign-in and builds the master in the browser.
Nothing is stored on GitHub. Patient addresses go to Google Maps when you plan routes (driver
addresses go there too, for suggestions).

Routes you send, and what drivers record (photos and signatures included), are saved in the
**PHLO Dispatch** folder of the yourphlo Google Drive by the dispatch server (below), and stay there
until you delete them. A free gmail.com account comes without a HIPAA agreement with Google
(a BAA); a Google Workspace account can have one.

Otherwise patient data is never saved in the browser or kept between visits. **Sign out** clears the page.
(Older versions kept past deliveries in the browser; the page deletes that copy the first time it
opens on that computer.) Downloaded `.xlsx` files
are in your Downloads folder, so delete them there when you're done with them.

### Web app setup (one time, about 15 minutes)

**1. Publish the page**

- GitHub Pages needs either a **public** repo (free) or a paid GitHub plan for a private repo.
  The code has no patient data in it (sheet ids only, which need your Google login to open).
- Repo **Settings > Pages > Build and deployment > Source: GitHub Actions**.
- Publish it: repo **Actions** tab > **Test and publish web app** > **Run workflow** > **Run
  workflow**. After that it republishes by itself whenever the code changes.
  The page is at `https://yourphlo.github.io/phlo/` (also shown in Settings > Pages).

**2. Create the Google sign-in key (OAuth client ID)** at https://console.cloud.google.com

1. Create a project (e.g. "PHLO").
2. **APIs & Services > Library**: enable **Google Sheets API** and **Google Drive API**.
3. **Google Auth Platform** (OAuth consent screen): app name "PHLO Master", your email,
   audience **External**. Under **Audience > Test users**, add every Google account that will
   use the page (e.g. yourphlo@gmail.com). Leave the app in *Testing*.
4. **Data access > Add scopes**: `.../auth/spreadsheets.readonly`, `.../auth/drive.readonly` and
   `.../auth/drive.appdata` (the last one saves the driver profiles in your Drive's hidden app folder).
5. **Clients > Create client > Web application**. Under **Authorized JavaScript origins** add
   `https://yourphlo.github.io` (and `http://localhost:8000` for testing on a computer).
   Create, then copy the **Client ID** (ends in `.apps.googleusercontent.com`).

**3. Give the page the client ID** - either paste it into `web/config.js` (`clientId: '...'`)
and push, or paste it into the setup box the first time you open the page (remembered in that
browser).

**4. Google Maps (address suggestions, coverage map, route planning)** in the same Google Cloud project

1. Google Maps needs a billing account on the project (**Billing**). Address suggestions for a few
   drivers should stay within Google's free monthly usage, but set a budget alert to be safe.
2. **APIs & Services > Library**: enable **Maps JavaScript API**, **Places API (New)**,
   **Geocoding API** and **Routes API** (the last two plan the routes).
3. **APIs & Services > Credentials > Create credentials > API key**. Edit the key:
   - **Application restrictions: Websites**, add `https://yourphlo.github.io/*` (and
     `http://localhost:8000/*` for testing on a computer).
   - **API restrictions: Restrict key** to Maps JavaScript API, Places API (New), Geocoding API and
     Routes API.
   Planning a day costs about half a cent per address and about a cent per driver; set a budget
   alert under **Billing** to be safe.
4. Paste the key into `web/config.js` (`mapsApiKey: '...'`) and push. A key limited to your website
   is meant to be in the page; it doesn't work from anywhere else.

**5. Dispatch server (for the driver app)**: follow `apps-script-dispatch/README.md`, then put the
web app URL in `web/config.js` (`dispatchUrl: '...'`) and push. Until then the Dispatch tab plans
and prints routes, but can't send them, and drivers can't sign in.

The first sign-in shows "Google hasn't verified this app" because it's your own private app;
click **Continue**.

To try it on a computer instead: `cd web && python3 -m http.server 8000`, then open
http://localhost:8000.

## Google Sheets menu: one-time setup (about 5 minutes)

1. In Google Drive create a new Google Sheet, e.g. **PHLO MASTER**.
2. In that sheet: **Extensions > Apps Script**.
3. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs), then add
   two more script files (**+ > Script**) named `Core` and `Stores` and paste in
   [`apps-script/Core.gs`](apps-script/Core.gs) and [`apps-script/Stores.gs`](apps-script/Stores.gs).
4. Click the gear (**Project Settings**) > tick **Show "appsscript.json"**, then replace
   `appsscript.json` with [`apps-script/appsscript.json`](apps-script/appsscript.json).
   (This turns on the Drive service needed to read the Arcadia KM2 `.xlsx`.)
5. Save, reload the spreadsheet. A **PHLO** menu appears. The first run asks you to
   authorize access to your Drive/Sheets.

### Daily use

- **PHLO > Build master for tomorrow's deliveries** - run in the evening after the stores
  finish entering. Creates a tab named like `10.20.26`.
- **PHLO > Build master for a date…** - same, for any delivery date.
- **PHLO > Save current tab as .xlsx in Drive** - saves `10.20.26_UPLOAD.xlsx` next to
  the master sheet with a download link.

A popup lists how many rows came from each store, so a store that's missing or
empty stands out.

## How rows are picked

For delivery date D:

1. If a row's notes name a delivery date (`DEL 10.20.2026`, `DELIVERY ON 10/20`,
   `must be delivered 10/20`, `10/20 - MORNING`), the row goes on that date only.
2. Otherwise its pickup date must be the day before D (Saturday + Sunday when D is a
   Monday). The pickup date is the store's date column (carried down to following
   rows) or a `PHLO PICK UP ON 10/19/2026` banner, whichever is later.

## How each row is formatted

| Column | Built from |
|---|---|
| NAME | `RX#,LAST,FIRST`; patients at the same address become one combo row: `5147457, 5147468,RIVERA,GILBERTO, & AYALA,ISABEL` |
| ADDRESS | Address with phone numbers, commas and `**...**` tags removed; ZIP+4 cut to 5 digits |
| NOTES | Store code (VALLEY, LV, WT, WT DME, RM, ARC, TC, PDSN, WSTR, ARC2, BP, SG, EM, TX) |
| NOTES 2 | `$copay-COMBO-FRIDGE-notes`, with delivery dates, `BAG 1 OF 2`, `WITH …` and arrows removed |

## Stores

Configured in the `STORES` list in [`web/stores.js`](web/stores.js) (sheet id + which column
holds what). If a store starts a new spreadsheet, paste its id there. The parsing logic is
[`web/core.js`](web/core.js). After editing either, run `node scripts/sync-apps-script.js`
to copy them into `apps-script/`. Monthly tabs are found by
name (`OCT 2026`, `October 2026`, `RX OCT 2026`, `OCT-2026`, …).

- **BP** has no October sheet in Drive yet. It's set to use the newest spreadsheet whose
  name contains "BP" and "PHLO", one tab per day (`Mon 10/19/26`), the layout of the
  June file. Check its row count in the popup the first time it runs.
- **SG** only takes rows marked `Phlo` (it also lists other drivers).
- **TX** (TX DELIVERY 2026) only reads its **PHLO** tab, not the daily route tabs (those are
  TX's own drivers). Each block starts with a date row like `10/20` and goes on the next day's
  master. Rows are care homes: `RX#s,HOME NAME`, with the bag count in NOTES 2 (`3 BAGS`;
  one bag is not noted).

## Tests

- `node test/run.js` - logic checks (run by GitHub Actions on every push), plus checks
  against local sheet snapshots in `test/fixtures/` when present (kept out of git because
  they hold patient data).
- `node test/dispatch-e2e.js [screenshot-dir]` - plans, prints and sends routes, then signs in as a
  driver and records a delivery, in Chromium with Google and the dispatch server faked (the real
  `Server.gs` runs on stand-ins for Apps Script; needs Playwright).
- `XLSX_JS=path/to/xlsx.full.min.js node test/e2e.js [file.xlsx]` - drives the web app in
  Chromium with Google's APIs faked from those snapshots (needs Playwright).
