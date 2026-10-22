// Usage: node scripts/reconcile/compare-old-app.mjs --old <export.json> [--old <more.json>] --backup <backup folder> --out <folder OUTSIDE the repo>
// Offline and read-only: reads the exports and the backup's data.json, writes a report (reconciliation.md / .json) and
// import-candidates.xlsx (devices only in the old app) into --out. Never contacts a database, never changes an input.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOldExports, reconcile } from './reconcile-core.mjs'

const args = process.argv.slice(2)
const get = (f) => args.flatMap((a, i) => (a === f ? [args[i + 1]] : []))
const olds = get('--old'), backup = get('--backup')[0], out = get('--out')[0]
if (!olds.length || !backup || !out) { console.error('Need --old <file> (repeatable), --backup <folder>, --out <folder>'); process.exit(1) }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outAbs = path.resolve(out)
if (outAbs === repo || outAbs.startsWith(repo + path.sep)) { console.error('Refusing: --out must be outside the repository (the report contains business data).'); process.exit(1) }

const old = parseOldExports(olds.map((f) => ({ name: path.basename(f), json: JSON.parse(fs.readFileSync(f, 'utf8')) })))
const data = JSON.parse(fs.readFileSync(path.join(backup, 'data.json'), 'utf8'))
const r = reconcile(old, data)
fs.mkdirSync(outAbs, { recursive: true })
fs.writeFileSync(path.join(outAbs, 'reconciliation.json'), JSON.stringify(r, null, 2))

const L = []
const row = (x) => `${x.serial || '(none)'} | ${x.name || ''} | ${x.status} | ${x.assigned || '-'} | ${x.location || '-'}`
L.push('# Reconciliation: old app vs production backup', '', 'Read-only. Nothing was written to any database or to either input.', '')
L.push('Old export counts: ' + JSON.stringify(r.counts.old), ...(r.counts.problems.length ? ['PROBLEMS: ' + r.counts.problems.join('; ')] : []), '')
let importable = 0
for (const [fam, c] of Object.entries(r.families)) {
  L.push(`## ${fam}`, `same ${c.same.length} · changed ${c.changed.length} · only in old app ${c.onlyOld.length} · only in database ${c.onlyNew.length} · duplicates ${c.duplicate.length} · old without serial ${c.noSerialOld.length}`, '')
  if (c.changed.length) { L.push('### Changed (a person decides; imports never overwrite)'); c.changed.forEach((x) => L.push(`- ${x.old.serial}: ` + Object.entries(x.diffs).map(([k, [a, b]]) => `${k} old="${a}" db="${b}"`).join('; '))); L.push('') }
  if (c.onlyOld.length) { L.push('### Only in the old app (import candidates)'); c.onlyOld.forEach((x) => L.push('- ' + row(x))); L.push(''); importable += c.onlyOld.length }
  if (c.duplicate.length) { L.push('### Duplicates (never merged automatically)'); c.duplicate.forEach((d) => L.push(`- ${d.key}: old ${d.old.length}, database ${d.new.length}`)); L.push('') }
  if (c.noSerialOld.length) { L.push('### Old items without a serial (cannot be matched)'); c.noSerialOld.forEach((x) => L.push('- ' + row(x))); L.push('') }
  if (c.onlyNew.length) L.push(`(${c.onlyNew.length} database devices are not in the old export: normal if added after the old app or never in it.)`, '')
}
L.push('## Bulk Stock', `only in old app ${r.bulk.onlyOld.length} · in both ${r.bulk.inBoth.length}`, ...r.bulk.onlyOld.map((b) => `- ${b.name} (${b.category}) ${JSON.stringify(b.buckets)}`), '')
L.push('## Onboarding cases', `open in old app, not in database ${r.onboarding.open.length} · completed ${r.onboarding.done.length} · already in database ${r.onboarding.inNew.length}`, ...r.onboarding.open.map((o) => `- OPEN: ${o.employeeName}`), '')

// Import candidates (Excel). Format is a plain sheet; a person maps it in the import wizard. The import only ADDS rows.
let xlsxNote = ''
try {
  const XLSX = (await import('xlsx')).default ?? (await import('xlsx'))
  const wb = XLSX.utils.book_new()
  for (const [fam, c] of Object.entries(r.families)) {
    const rows = c.onlyOld.map((x) => ({ Name: x.name, Category: x.category, Serial: x.serial, Status: x.status, 'Assigned to': x.assigned, Location: x.location, 'Old-app history entries': x.history }))
    if (rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), fam)
  }
  if (wb.SheetNames.length) { fs.writeFileSync(path.join(outAbs, 'import-candidates.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })); xlsxNote = 'import-candidates.xlsx written (one sheet per family).' }
} catch (e) { xlsxNote = 'xlsx unavailable: ' + e.message }
L.push('## Import plan', importable ? `${importable} devices exist only in the old app. ${xlsxNote} Review, then import through the app's wizard (adds only; existing devices are never changed). Doing so is a business-data decision and needs the owner's approval.` : 'No device exists only in the old app: nothing to import.', 'Changed fields and duplicates are decided by a person per item; no tool applies them.')
fs.writeFileSync(path.join(outAbs, 'reconciliation.md'), L.join('\n'))
console.log(L.join('\n'))
