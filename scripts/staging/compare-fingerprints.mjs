// Compares two CSV exports of supabase/staging/schema-fingerprint.sql
// (one from production, one from staging) and lists every difference.
// Works on local files only — it never connects to anything.
//
//   npm run staging:compare -- prod.csv staging.csv
import { readFileSync } from 'node:fs'

const [prodFile, stagingFile] = process.argv.slice(2)
if (!prodFile || !stagingFile) {
  console.error('Usage: npm run staging:compare -- <production.csv> <staging.csv>')
  process.exit(1)
}

// Minimal RFC 4180 parser (quoted fields may contain commas and quotes).
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      if (row.some((f) => f !== '')) rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  row.push(field)
  if (row.some((f) => f !== '')) rows.push(row)
  return rows
}

function load(file) {
  const [header, ...rows] = parseCsv(readFileSync(file, 'utf8'))
  const idx = ['kind', 'name', 'fingerprint'].map((c) => header.indexOf(c))
  if (idx.includes(-1)) {
    console.error(`${file}: expected columns kind,name,fingerprint — got ${header.join(',')}`)
    process.exit(1)
  }
  return new Map(rows.map((r) => [`${r[idx[0]]}  ${r[idx[1]]}`, r[idx[2]]]))
}

const prod = load(prodFile)
const staging = load(stagingFile)
const onlyProd = [...prod.keys()].filter((k) => !staging.has(k))
const onlyStaging = [...staging.keys()].filter((k) => !prod.has(k))
const different = [...prod.keys()].filter((k) => staging.has(k) && staging.get(k) !== prod.get(k))

const section = (title, items) => {
  console.log(`\n${title} (${items.length})`)
  for (const k of items) console.log(`  ${k}`)
}
console.log(`Production objects: ${prod.size}   Staging objects: ${staging.size}`)
section('Only in PRODUCTION', onlyProd)
section('Only in STAGING', onlyStaging)
section('Same name, DIFFERENT definition', different)
const total = onlyProd.length + onlyStaging.length + different.length
console.log(total === 0 ? '\n✔ Staging matches production exactly.' : `\n${total} difference(s) — review before testing (see the guide, step 5).`)
process.exit(total === 0 ? 0 : 2)
