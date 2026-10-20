# PHLO master builder

Builds the daily PHLO upload sheet (`NAME | ADDRESS | NOTES | NOTES 2`) from every
pharmacy's delivery Google Sheet.

## One-time setup (about 5 minutes)

1. In Google Drive create a new Google Sheet, e.g. **PHLO MASTER**.
2. In that sheet: **Extensions > Apps Script**.
3. Replace the contents of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs).
4. Click the gear (**Project Settings**) > tick **Show "appsscript.json"**, then replace
   `appsscript.json` with [`apps-script/appsscript.json`](apps-script/appsscript.json).
   (This turns on the Drive service needed to read the Arcadia KM2 `.xlsx`.)
5. Save, reload the spreadsheet. A **PHLO** menu appears. The first run asks you to
   authorize access to your Drive/Sheets.

## Daily use

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
| NOTES | Store code (VALLEY, LV, WT, WT DME, RM, ARC, TC, PDSN, WSTR, ARC2, BP, SG, EM) |
| NOTES 2 | `$copay-COMBO-FRIDGE-notes`, with delivery dates, `BAG 1 OF 2`, `WITH …` and arrows removed |

## Stores

Configured in the `STORES` list at the top of `Code.gs` (sheet id + which column holds
what). If a store starts a new spreadsheet, paste its id there. Monthly tabs are found by
name (`OCT 2026`, `October 2026`, `RX OCT 2026`, `OCT-2026`, …).

- **BP** has no October sheet in Drive yet. It's set to use the newest spreadsheet whose
  name contains "BP" and "PHLO", one tab per day (`Mon 10/19/26`), the layout of the
  June file. Check its row count in the popup the first time it runs.
- **SG** only takes rows marked `Phlo` (it also lists other drivers).

## Tests

`node test/run.js` runs the parsing logic against local sheet snapshots in
`test/fixtures/` (kept out of git because they hold patient data).
