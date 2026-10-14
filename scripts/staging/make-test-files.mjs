// Generates the files used by docs/STAGING_APP_TESTING.md, all with
// synthetic data matching `npm run staging:seed`:
//   .staging-state/test-files/*.xlsx      Excel import scenarios
//   .staging-state/test-files/scan-labels.html   printable QR labels
// Local files only — this never connects to anything.
//
//   npm run staging:test-files
import * as fs from 'node:fs'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import QRCode from 'qrcode'
import { ROOT } from './lib.mjs'

XLSX.set_fs(fs)
const OUT = join(ROOT, '.staging-state', 'test-files')
fs.mkdirSync(OUT, { recursive: true })

function sheet(file, rows) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Equipment')
  XLSX.writeFile(wb, join(OUT, file))
  console.log(`  ${file}`)
}

console.log(`Writing test files to ${OUT}`)

// 1. Normal import: four new monitors -> 4 "Create".
sheet('01-monitors-new.xlsx', [
  ['Name', 'Category', 'Serial', 'Location'],
  ['Dell 27 Monitor', 'Monitor', 'SYN-MON-101', 'Tampa Office'],
  ['Dell 27 Monitor', 'Monitor', 'SYN-MON-102', 'Tampa Office'],
  ['LG 32 Monitor', 'Monitor', 'SYN-MON-103', 'Remote'],
  ['LG 32 Monitor', 'Monitor', 'SYN-MON-104', 'Remote'],
])

// 2. Validation: 1 good row, 3 rows the preview must reject.
sheet('02-inventory-with-errors.xlsx', [
  ['Name', 'Category', 'Serial', 'Status'],
  ['Dell Latitude 5440', 'Laptop', 'SYN-INV-201', 'available'],
  ['Dell Latitude 5440', 'Laptop', '', 'available'],
  ['Dell Latitude 5440', 'Laptop', 'SYN-INV-202', 'broken'],
  ['Dell Latitude 5440', 'Laptop', 'SYN-INV-201', 'available'],
])

// 3. KNOWN BUG C4: re-importing assigned NP laptops with no Status /
//    Assigned-to columns resets them to Available and unassigns them.
sheet('03-KNOWN-BUG-np-status-reset.xlsx', [
  ['Name', 'Category', 'Serial', 'Location'],
  ['Lenovo ThinkPad T14', 'Laptop', 'SYN-NP-001', 'Remote'],
  ['Lenovo ThinkPad T14', 'Laptop', 'SYN-NP-002', 'Remote'],
  ['Lenovo ThinkPad T14', 'Laptop', 'SYN-NP-003', 'Remote'],
])

// 4. KNOWN BUG H2: preview matches serials ignoring case, the save doesn't.
sheet('04-KNOWN-BUG-case-mismatch.xlsx', [
  ['Name', 'Category', 'Serial'],
  ['Dell Latitude 5440', 'Laptop', 'syn-inv-012'],
])

// 5. KNOWN BUG H3: a laptop currently in Active Laptops (NP) imported into
//    Laptop Inventory creates a second record.
sheet('05-KNOWN-BUG-cross-collection.xlsx', [
  ['Name', 'Category', 'Serial'],
  ['Dell Latitude 5440', 'Laptop', 'SYN-INV-001'],
])

// 6. Bulk import; KNOWN BUG H4: importing it twice adds the stock twice.
sheet('06-bulk-received.xlsx', [
  ['Name', 'Category', 'Location', 'Quantity'],
  ['Wireless Mouse', 'Accessory', 'Tampa Office', 10],
  ['Webcam', 'Accessory', 'Tampa Office', 8],
])

// 7. KNOWN BUG M5: a header with a trailing space makes every value read as empty.
sheet('07-KNOWN-BUG-header-space.xlsx', [
  ['Name', 'Category', 'Serial '],
  ['Headset', 'Headset', 'SYN-OTH-201'],
  ['Headset', 'Headset', 'SYN-OTH-202'],
])

// Printable QR labels for the scanner.
const LABELS = [
  ['SYN-INV-021', 'Laptop Inventory — opens the laptop'],
  ['SYN-INV-001', 'Moved to Active Laptops (NP) — opens it there'],
  ['SYN-MON-007', 'Monitors — opens the monitor'],
  ['SYN-OTH-003', 'Other Equipment — opens the dock'],
  ['SYN-NEW-001', 'Not in the ledger — offers to add it'],
  ['SYN-DUP-A', 'KNOWN BUG M2: exists in two collections — opens one without warning'],
]
const cards = []
for (const [serial, note] of LABELS) {
  const svg = await QRCode.toString(serial, { type: 'svg', margin: 2, width: 180 })
  cards.push(`<figure>${svg}<figcaption><b>${serial}</b><br>${note}</figcaption></figure>`)
}
fs.writeFileSync(
  join(OUT, 'scan-labels.html'),
  `<!doctype html><meta charset="utf-8"><title>Staging scan labels (synthetic)</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; color: #111; background: #fff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 24px; }
  figure { margin: 0; padding: 12px; border: 1px solid #ccc; border-radius: 8px; text-align: center; }
  figcaption { margin-top: 8px; line-height: 1.4; }
</style>
<h1>Equipment Ledger — STAGING scan labels</h1>
<p>Synthetic serials from <code>npm run staging:seed</code>. Show this page on a phone or print it, then scan with the staging app's Scan page.</p>
<div class="grid">${cards.join('\n')}</div>
`,
)
console.log('  scan-labels.html')
console.log('\n✔ Done.')
