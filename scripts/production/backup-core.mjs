// Logical backup of a database's public schema and data, plus the means to verify it and restore it into a
// disposable database. READ-ONLY on the source: one REPEATABLE READ, READ ONLY transaction, so every table
// is read at the same instant. The backup folder contains personal data (assignee names, emails): keep it
// on an encrypted disk, outside the repository, and never share it.
//
// Files in the folder:
//   data.json        { table: [row, …] }              every row of every public base table
//   signature.json   [line, …]                        the full schema signature (schema-signature.mjs)
//   manifest.json    counts + per-table content hash + column lists + migration history + sha256 of the files
//   SHA256SUMS.txt   sha256 of the three files above (for `Get-FileHash` / sha256sum checks)
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { schemaSignature } from './schema-signature.mjs'

const ident = (s) => '"' + s.replaceAll('"', '""') + '"'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
export const FORMAT = 'ledger-db-backup-1'

/** The same content hash on the source and on the restored copy (UTC, columns in table order). */
export async function tableDigest(q, table, columns) {
  const cols = columns.map(ident).join(', ')
  const r = (await q(`select count(*)::int as n, md5(coalesce(string_agg(r::text, '|' order by r::text), '')) as h from (select row(${cols}) as r from public.${ident(table)}) x`))[0]
  return { count: r.n, hash: r.h }
}

async function tablesWithColumns(q) {
  return q(`select c.table_name, array_agg(c.column_name::text order by c.ordinal_position) as columns
    from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE' group by c.table_name order by c.table_name`)
}

/**
 * @param q  read-only query function, ALREADY inside the read-only repeatable-read transaction
 * @param opts { outDir, projectRef?, note? }
 */
export async function exportBackup(q, { outDir, projectRef = null }) {
  if (existsSync(outDir) && readdirSync(outDir).length) throw new Error(`${outDir} is not empty; choose a new folder.`)
  mkdirSync(outDir, { recursive: true })
  await q(`set local timezone = 'UTC'`)
  const version = (await q(`select current_setting('server_version') as v`))[0].v
  const history = (await q(`select to_regclass('supabase_migrations.schema_migrations') is not null as e`))[0].e
    ? (await q(`select version, name from supabase_migrations.schema_migrations order by version`)) : []
  const data = {}
  const tables = {}
  for (const { table_name, columns } of await tablesWithColumns(q)) {
    data[table_name] = (await q(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as rows from public.${ident(table_name)} t`))[0].rows
    tables[table_name] = { columns, ...(await tableDigest(q, table_name, columns)) }
    if (data[table_name].length !== tables[table_name].count) throw new Error(`${table_name}: read ${data[table_name].length} rows but the table has ${tables[table_name].count}`)
  }
  const signature = await schemaSignature(q)
  const files = { 'data.json': JSON.stringify(data), 'signature.json': JSON.stringify(signature) }
  for (const [f, text] of Object.entries(files)) writeFileSync(join(outDir, f), text)
  const manifest = {
    format: FORMAT, taken_at: new Date().toISOString(), project_ref: projectRef, server_version: version,
    migration_history: history, tables, signature_lines: signature.length,
    sha256: Object.fromEntries(Object.entries(files).map(([f, text]) => [f, sha256(Buffer.from(text))])),
  }
  const manifestText = JSON.stringify(manifest, null, 2)
  writeFileSync(join(outDir, 'manifest.json'), manifestText)
  writeFileSync(join(outDir, 'SHA256SUMS.txt'), [...Object.entries(manifest.sha256), ['manifest.json', sha256(Buffer.from(manifestText))]].map(([f, h]) => `${h}  ${f}`).join('\n') + '\n')
  return verifyBackupFiles(outDir)
}

/** Offline checks on the folder: files present and unchanged, every table's rows complete. Returns a summary or throws. */
export function verifyBackupFiles(dir) {
  const read = (f) => readFileSync(join(dir, f))
  const manifest = JSON.parse(read('manifest.json').toString('utf8'))
  if (manifest.format !== FORMAT) throw new Error(`Unknown backup format ${manifest.format}`)
  for (const [f, h] of Object.entries(manifest.sha256)) if (sha256(read(f)) !== h) throw new Error(`${f} does not match its recorded SHA-256: the file changed or is damaged`)
  const sums = readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').map((l) => l.split(/\s{2}/))
  for (const [h, f] of sums) if (sha256(read(f)) !== h) throw new Error(`${f} does not match SHA256SUMS.txt`)
  const data = JSON.parse(read('data.json').toString('utf8'))
  const signature = JSON.parse(read('signature.json').toString('utf8'))
  const problems = []
  for (const [t, m] of Object.entries(manifest.tables)) {
    if (!Array.isArray(data[t])) problems.push(`${t}: missing from data.json`)
    else if (data[t].length !== m.count) problems.push(`${t}: ${data[t].length} rows in the file, ${m.count} in the database`)
  }
  for (const t of Object.keys(data)) if (!manifest.tables[t]) problems.push(`${t}: in data.json but not in the manifest`)
  if (signature.length !== manifest.signature_lines) problems.push('signature.json has a different number of lines than recorded')
  if (problems.length) throw new Error('Backup is NOT complete:\n  ' + problems.join('\n  '))
  return { manifest, tables: Object.keys(manifest.tables).length, rows: Object.values(manifest.tables).reduce((n, m) => n + m.count, 0) }
}

/**
 * Loads a backup into a disposable database whose schema matches (every row, triggers and foreign keys out of the way),
 * then proves the copy is faithful: every table's row count and content hash equal the source's.
 * @param db { query(sql, params) -> { rows }, exec(sql) }
 */
export async function restoreBackup(db, dir) {
  const { manifest } = verifyBackupFiles(dir)
  const data = JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8'))
  const q = (sql, p = []) => db.query(sql, p).then((r) => r.rows)
  await db.exec('begin')
  try {
    await db.exec(`set local session_replication_role = replica`)
    await db.exec(`set local timezone = 'UTC'`)
    for (const p of data.profiles ?? []) await db.query(`insert into auth.users (id, email, is_anonymous) values ($1, $2, false) on conflict (id) do nothing`, [p.id, p.email ?? null])
    for (const [t, rows] of Object.entries(data)) {
      if (!rows.length) continue
      const cols = (await q(`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER' order by ordinal_position`, [t])).map((r) => ident(r.c)).join(', ')
      if (!cols) throw new Error(`The disposable database has no table ${t}: its schema does not match the backup`)
      await db.query(`insert into ${ident(t)} (${cols}) select ${cols} from jsonb_populate_recordset(null::${ident(t)}, $1::jsonb)`, [JSON.stringify(rows)])
    }
    await db.exec('commit')
  } catch (err) {
    await db.exec('rollback').catch(() => {})
    throw err
  }
  await db.exec(`set timezone = 'UTC'`)
  const mismatches = []
  for (const [t, m] of Object.entries(manifest.tables)) {
    const cols = (await q(`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [t])).map((r) => r.c)
    if (JSON.stringify(cols) !== JSON.stringify(m.columns)) { mismatches.push(`${t}: columns differ (${m.columns.join(',')} vs ${cols.join(',')})`); continue }
    const d = await tableDigest(q, t, cols)
    if (d.count !== m.count || d.hash !== m.hash) mismatches.push(`${t}: restored ${d.count} rows / ${d.hash.slice(0, 8)}, source ${m.count} / ${m.hash.slice(0, 8)}`)
  }
  return { manifest, mismatches }
}
