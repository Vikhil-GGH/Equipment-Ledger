// The production migration steps, as plain functions over a tiny database interface, so the exact same
// code is rehearsed on a disposable database (tests) and run, by the owner's approval, against production
// (apply-migration.mjs). It decides nothing on its own: every step is named explicitly and checked first.
//
//   db = { query(sql, params) -> { rows }, exec(sql) }   (a pg client wrapper, or PGlite in the rehearsal)
//
// Steps:
//   record  <version>   the migration is already in place (see migration-state.mjs): add its history row only
//   apply   <version>   run one migration, with its documented adaptation, in ONE transaction, and record it
// Rules enforced here (not left to the operator):
//   - the history table is only ever written together with a verified state (record) or the migration itself (apply)
//   - apply runs only the LOWEST migration that is neither recorded nor in place: strictly in order, one at a time
//   - a partially present migration stops everything
//   - an already recorded migration is refused
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { detectMigration, reconcile } from './migration-state.mjs'

export const BASE_LAST = '20260901000020' // the history that "should" be there before the plan starts (001–020)

/** Documented adaptations (supabase/adaptations/): NNN_before_*.sql runs before migration NNN, NNN_after_*.sql after, same transaction. */
export function adaptationsFor(adaptationsDir, version) {
  const n = version.slice(-3)
  const files = readdirSync(adaptationsDir).filter((f) => f.startsWith(n + '_') && f.endsWith('.sql')).sort()
  const read = (f) => readFileSync(join(adaptationsDir, f), 'utf8')
  return {
    before: files.filter((f) => f.startsWith(`${n}_before_`)).map(read),
    after: files.filter((f) => f.startsWith(`${n}_after_`)).map(read),
  }
}

export async function ensureHistoryTable(db) {
  await db.exec(`create schema if not exists supabase_migrations`)
  await db.exec(`create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)`)
}
export const recordedVersions = async (db) => (await db.query(`select version from supabase_migrations.schema_migrations order by version`)).rows.map((r) => r.version)

/** The plan for the whole chain: reconcile 001–020, then 021…latest as plain "apply" steps. */
export async function planChain(db, migrations) {
  const recorded = await recordedVersions(db)
  const base = await reconcile((sql, p = []) => db.query(sql, p).then((r) => r.rows), migrations, recorded, BASE_LAST)
  const rest = migrations.filter((m) => m.version > BASE_LAST).map((m) => ({ version: m.version, name: m.name, action: recorded.includes(m.version) ? 'recorded' : 'apply', present: [], missing: [] }))
  return [...base, ...rest]
}

export async function recordStep(db, migrations, version) {
  const m = migrations.find((x) => x.version === version)
  if (!m) throw new Error(`Unknown migration ${version}`)
  if ((await recordedVersions(db)).includes(version)) throw new Error(`${version} is already recorded`)
  const d = await detectMigration((sql, p = []) => db.query(sql, p).then((r) => r.rows), m)
  if (d.status !== 'applied') throw new Error(`Refusing to record ${version}: it is ${d.status} (${d.missing.join('; ') || 'nothing found'}), not fully in place`)
  await db.query(`insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)`, [version, m.name.replace(/^\d+_/, '').replace(/\.sql$/, '')])
  return d
}

/** Applies exactly one migration, in order, in one transaction. `sqlFiles` maps file name -> original text (comments intact). */
export async function applyStep(db, migrations, version, { sqlFor, adaptationsDir }) {
  const m = migrations.find((x) => x.version === version)
  if (!m) throw new Error(`Unknown migration ${version}`)
  const recorded = await recordedVersions(db)
  if (recorded.includes(version)) throw new Error(`${version} is already recorded`)
  const q = (sql, p = []) => db.query(sql, p).then((r) => r.rows)
  // Strict order: nothing earlier may be left undone.
  for (const earlier of migrations.filter((x) => x.version < version && !recorded.includes(x.version))) {
    const d = await detectMigration(q, earlier)
    if (d.status !== 'applied') throw new Error(`Cannot apply ${version}: ${earlier.version} is ${d.status === 'absent' ? 'not applied' : d.status} (apply or record it first)`)
    throw new Error(`Cannot apply ${version}: ${earlier.version} is in place but not recorded (record it first)`)
  }
  if (version <= BASE_LAST) {
    const d = await detectMigration(q, m)
    if (d.status === 'applied') throw new Error(`${version} is already in place (record it, do not re-run it)`)
    if (d.status === 'partial') throw new Error(`${version} is partly in place (${d.present.join('; ')} present; ${d.missing.join('; ')} missing): stop and look`)
  }
  const ad = adaptationsFor(adaptationsDir, version)
  await db.exec('begin')
  try {
    for (const sql of ad.before) await db.exec(sql)
    await db.exec(sqlFor(m))
    for (const sql of ad.after) await db.exec(sql)
    await db.query(`insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)`, [version, m.name.replace(/^\d+_/, '').replace(/\.sql$/, '')])
    await db.exec('commit')
  } catch (err) {
    await db.exec('rollback').catch(() => {})
    throw new Error(`${m.name} failed and was rolled back; nothing from it was applied. ${err.message}`)
  }
}

/**
 * Rolls back ONE migration with its documented down script: only the most recently recorded one, only if a verified
 * down script exists (035..029), in one transaction together with removing its history row. Older migrations are
 * deliberately not rolled back here (029 keeps a private backup of employee history, so going further back needs a
 * deliberate, approved removal of that data; the restore point covers it).
 */
export const ROLLBACKABLE = ['20260901000035', '20260901000034', '20260901000033', '20260901000030', '20260901000029']
export async function rollbackStep(db, version, { rollbackDir }) {
  const recorded = await recordedVersions(db)
  if (!ROLLBACKABLE.includes(version)) throw new Error(`${version} cannot be rolled back automatically (verified rollbacks: ${ROLLBACKABLE.join(', ')})`)
  if (recorded.at(-1) !== version) throw new Error(`${version} is not the most recently applied migration (${recorded.at(-1)} is): roll that back first`)
  const sql = readFileSync(join(rollbackDir, `${version}_down.sql`), 'utf8')
  await db.exec('begin')
  try {
    await db.exec(sql)
    const r = await db.query(`delete from supabase_migrations.schema_migrations where version = $1`, [version])
    if (r.rowCount !== 1) throw new Error('history row not found')
    await db.exec('commit')
  } catch (err) {
    await db.exec('rollback').catch(() => {})
    throw new Error(`Rollback of ${version} failed and was undone; nothing changed. ${err.message}`)
  }
}
