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

1. Open the page and **Sign in with Google** (the account that can see the store sheets).
2. Pick the **delivery date** (defaults to tomorrow) and click **Build master**.
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

1. Click **Add driver**, fill in the form, **Save driver**. Click a name later to edit it, × to delete.
2. Pick the **Working on** date (defaults to tomorrow) and tick who is driving that day. A new
   date starts with the same drivers as the last day you set.
3. **Download drivers .xlsx** saves the working drivers (`10.21.26_DRIVERS.xlsx`), one row per
   driver with the fields above.

When you're signed in, profiles are saved to your own Google account (a hidden app folder in
your Google Drive), so they show up on any computer once you sign in with the same account.
Signed out, they are kept in that browser only and uploaded the next time you sign in.

Patient data never leaves your browser and Google: the page reads the sheets with your own
Google sign-in and builds the file locally. Nothing is stored on GitHub.

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
- `XLSX_JS=path/to/xlsx.full.min.js node test/e2e.js [file.xlsx]` - drives the web app in
  Chromium with Google's APIs faked from those snapshots (needs Playwright).
