// READ-ONLY: proves, table by table, that production's pre-existing rows still equal a backup (same row counts and
// content hashes over the columns each table had in the backup). Run it after each migration step in the window.
//   powershell -ExecutionPolicy Bypass -File scripts\production\run-preflight.ps1 -Task compare -BackupDir "<backup folder>"
// Prints counts and verdicts only. Exit code 0 = every table the same, 2 = something changed or is missing.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { compareToBackup, verifyBackupFiles } from './backup-core.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const fail = (m) => { console.error(`\n✖ ${m}\n`); process.exit(1) }
const i = process.argv.indexOf('--backup')
const dir = i >= 0 ? resolve(process.argv[i + 1] ?? '') : null
if (!dir || !existsSync(join(dir, 'manifest.json'))) fail('Give --backup <the backup folder>.')
const url = process.env.PRODUCTION_DB_URL
if (!url) fail('PRODUCTION_DB_URL is not set (use the launcher script).')
const caPath = process.env.PRODUCTION_DB_SSL_CA ? resolve(ROOT, process.env.PRODUCTION_DB_SSL_CA) : null
if (!caPath || !existsSync(caPath)) fail('PRODUCTION_DB_SSL_CA must point to the CA certificate.')
const summary = verifyBackupFiles(dir)
const u = new URL(url)
const client = new pg.Client({ connectionString: url.replace(/[?&]sslmode=[^&]*/, ''), ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true, servername: u.hostname } })
await client.connect()
let bad = 0
try {
  await client.query('begin isolation level repeatable read read only')
  console.log(`Connected to ${u.hostname} — server certificate verified — read-only. Backup taken ${summary.manifest.taken_at} (${summary.tables} tables, ${summary.rows} rows).\n`)
  for (const r of await compareToBackup(async (sql, p = []) => (await client.query(sql, p)).rows, dir)) {
    if (r.status !== 'same') bad++
    console.log(`  ${r.status === 'same' ? '✔' : '✖'} ${r.table.padEnd(28)} ${r.status.padEnd(8)} rows then ${String(r.before).padStart(4)}, now ${r.now ?? '—'}${r.detail ? '  (' + r.detail + ')' : ''}`)
  }
} finally {
  await client.query('rollback').catch(() => {})
  await client.end()
}
console.log(bad ? `\n✖ ${bad} table(s) differ from the backup.` : '\n✔ Every pre-existing table equals the backup (rows and content).')
console.log('Nothing was written to the database.')
process.exit(bad ? 2 : 0)
