/**
 * PHLO store list - shared by the web app and the Apps Script.
 * Edit here, then run `node scripts/sync-apps-script.js` to copy into apps-script/.
 */

var MASTER_HEADERS = ['NAME', 'ADDRESS', 'NOTES', 'NOTES 2'];

/**
 * One entry per store, in the order they appear in the master.
 * cols are 0-based column numbers (A=0, B=1, ...).
 *   date    column with the pickup date (optional)
 *   id      RX / log number
 *   name    "NAME, ADDRESS" or "NAME|ADDRESS|PHONE" or "NAME\nADDRESS"
 *   address separate address column (only when name holds just the name)
 *   copay, fridge  optional
 *   notes   list of note columns, joined into NOTES 2
 * tab.prefix  only use monthly tabs whose name starts with this (e.g. RX / DME)
 * onlyIf      skip rows unless this column matches (SG lists other drivers too)
 * xlsx        the source is an .xlsx file in Drive, not a Google Sheet
 * search      find the file by name (newest match) instead of a fixed id
 * tabPerDay   one tab per pickup day named like "Mon 10/19/26"
 */
var STORES = [
  { code: 'VALLEY', title: '986 VLY#8012 PHLO LIST',
    id: '1m5VjllPLEtBgMJYaJeQ1co8RABXN82gB2okz8PFmd-c',
    cols: { date: 0, id: 3, name: 4, fridge: 5, copay: 6, notes: [7] } },
  { code: 'LV', title: '986LV SPREADSHEET',
    id: '1pYrsxKTV0WQpz3m7Kw-CWzum_nEs21O0v0Na6MH9J_Q',
    cols: { date: 0, id: 1, name: 2, copay: 3, notes: [4] } },
  { code: 'WT', title: '986 WHITTIER#8027 (RX tabs)',
    id: '1g7XITE-OcOng74Qhzppv6mCtWGcTjdoHxq17iKOOgTY', tab: { prefix: 'RX' },
    cols: { id: 0, name: 1, copay: 3, fridge: 4, notes: [6] } },
  { code: 'WT DME', title: '986 WHITTIER#8027 (DME tabs)',
    id: '1g7XITE-OcOng74Qhzppv6mCtWGcTjdoHxq17iKOOgTY', tab: { prefix: 'DME' },
    cols: { date: 0, id: 1, name: 2, notes: [3, 4] } },
  { code: 'RM', title: '986 #8030 PHLO DELIVERY SPREADSHEET',
    id: '1BcQSXpKu7sbvaz6AtfB8p1WMAkgM91RlUZVd8Bt0Hrs',
    cols: { date: 0, id: 1, name: 3, copay: 4, fridge: 5, notes: [6] } },
  { code: 'ARC', title: '986 ARCADIA PHLO LIST',
    id: '1I7vb98ZvNSVkN9ovkiaRSlnQ53dHhUtpnhbPMy9exN8',
    cols: { date: 0, id: 1, name: 2, notes: [3, 4, 5] } },
  { code: 'TC', title: 'TEMPLE CITY #8003 PHLO 2026',
    id: '15slSAd-zQg-uKEePGzNp9fZymJBApjGRekIlV3oSdMc',
    cols: { date: 0, id: 3, name: 4, copay: 5, fridge: 6, notes: [7, 8] } },
  { code: 'PDSN', title: '986 PSDN2#8032',
    id: '1tsBfURzPlPH4ZpnZ3gLdVkpy6EDGSKCofut85iMdtC8',
    cols: { date: 0, id: 3, name: 4, fridge: 5, copay: 6, notes: [7] } },
  { code: 'WSTR', title: '986 Westminster PHLO#8020',
    id: '1yJWPdFZaybRhW1VlqFRTaaw3z5R-SjXhlPUyL6kyO9M',
    cols: { date: 0, id: 3, name: 4, fridge: 5, copay: 6, notes: [7] } },
  { code: 'ARC2', title: 'Arcadia KM2 PHLO 2026.xlsx',
    id: '1sojU9EHFQ9wBoTH48TLZQY0Onop8DByp', xlsx: true,
    cols: { date: 0, id: 3, name: 4, copay: 5, fridge: 6, notes: [7] } },
  { code: 'BP', title: '986 BP PHLO (newest monthly file)',
    search: { titleContains: ['BP', 'PHLO'] }, tabPerDay: true,
    cols: { id: 2, name: 3, notes: [7], copay: 8 } },
  { code: 'SG', title: '986 SG#8037 (121460) - DELIVERY LOG',
    id: '1l_2pDmXwADKir-kHDxGqNUmany4NRFN4BEk_1YfDmfw',
    onlyIf: { col: 4, pattern: 'phlo' },
    cols: { date: 0, id: 1, name: 2, address: 3, notes: [5, 6] } },
  { code: 'EM', title: '986 EM#8000 PHLO',
    id: '1MwxHnyDnKRRYZTmXD42Xm7V48C-wvmlsa1a5k-yYgkw',
    cols: { date: 0, id: 1, name: 2, notes: [3] } }
];

