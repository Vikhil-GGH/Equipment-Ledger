// READ-ONLY logical backup of the production database (see backup-core.mjs). Writes only to a NEW local folder
// OUTSIDE the repository; nothing is written to the database. Needs the production connection from the launcher.
//
//   powershell -ExecutionPolicy Bypass -File scripts\production\run-preflight.ps1 -Task backup -OutDir D:\secure\ledger-prod-backup-2026-10-22
//
// The folder holds personal data (assignee names, emails): encrypted disk only, never the repository, chat or email.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { exportBackup } from './backup-core.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fail = (m) => { console.error(`\n✖ ${m}\n`); process.exit(1) }
const i = process.argv.indexOf('--out')
const out = i >= 0 ? resolve(process.argv[i + 1] ?? '') : null
if (!out) fail('Give --out <a NEW folder outside the repository>.')
if (!relative(ROOT, out).startsWith('..')) fail('The backup folder must be OUTSIDE the repository (it contains personal data).')
const url = process.env.PRODUCTION_DB_URL
if (!url) fail('PRODUCTION_DB_URL is not set (use the launcher script).')
const caPath = process.env.PRODUCTION_DB_SSL_CA ? resolve(ROOT, process.env.PRODUCTION_DB_SSL_CA) : null
if (!caPath || !existsSync(caPath)) fail('PRODUCTION_DB_SSL_CA must point to the CA certificate; the server certificate is always verified.')
const u = new URL(url)
const client = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true, servername: u.hostname } })
await client.connect()
try {
  await client.query('begin isolation level repeatable read read only')
  await client.query(`set local statement_timeout = '120s'`)
  console.log(`Connected to ${u.hostname} — server certificate verified — one consistent read-only snapshot.`)
  const summary = await exportBackup(async (sql, p = []) => (await client.query(sql, p)).rows, { outDir: out, projectRef: decodeURIComponent(u.username).split('.')[1] ?? null })
  console.log(`\n✔ Backup written and verified: ${summary.tables} tables, ${summary.rows} rows, ${summary.manifest.signature_lines} schema lines.`)
  console.log(`  Folder: ${out}`)
  console.log('  Per-table rows (counts only):')
  for (const [t, m] of Object.entries(summary.manifest.tables)) console.log(`    ${t.padEnd(28)} ${m.count}`)
  console.log(`  Migration history in the database: ${summary.manifest.migration_history.length} rows`)
  console.log('  SHA-256 of data.json:', summary.manifest.sha256['data.json'])
  console.log('\nKeep this folder on an encrypted disk. Do NOT put it in the repository, chat or email.')
} finally {
  await client.query('rollback').catch(() => {})
  await client.end()
}
console.log('Nothing was written to the database.')
