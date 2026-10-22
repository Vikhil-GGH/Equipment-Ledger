/**
 * Backup -> restore -> rehearse, end to end, on disposable databases.
 *
 *  - ALWAYS: a synthetic production-shaped database is backed up with the same code the production backup uses,
 *    and the whole rehearsal runs on that backup (proves the pipeline).
 *  - ON REQUEST: REHEARSAL_DIR=<folder made by `run-preflight.ps1 -Task backup`> runs the identical rehearsal on the
 *    REAL production backup. Output is counts, hashes and object names only, never row contents.
 *      REHEARSAL_DIR=D:\secure\ledger-prod-backup npm run test:db -- production-backup-rehearsal
 *    REHEARSAL_PRESENT="16" lists the migrations beyond the recorded history that are in place (production: 016).
 *
 * The rehearsal: verify the files; build the EXPECTED database (migrations 001-014 + the in-place ones) and require its
 * schema to be IDENTICAL to production's; restore the rows and require every table's count and content hash to match;
 * require the plan to be the one production reported; run the chain step by step requiring that NO pre-existing column
 * of NO pre-existing row changes at any step; require the final schema to equal a clean build; then run the
 * rollback scripts 035..029 in reverse and require the same row guarantee and the schema of the state just after 028.
 */
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs modules without type declarations
import { loadMigrations } from '../../../scripts/production/preflight-checks.mjs'
// @ts-expect-error
import { applyStep, ensureHistoryTable, planChain, recordStep, recordedVersions, rollbackStep } from '../../../scripts/production/apply-core.mjs'
// @ts-expect-error
import { duplicateSerialDetails } from '../../../scripts/production/migration-state.mjs'
// @ts-expect-error
import { diffSignatures, schemaSignature } from '../../../scripts/production/schema-signature.mjs'
// @ts-expect-error
import { compareToBackup, exportBackup, restoreBackup, tableDigest, verifyBackupFiles } from '../../../scripts/production/backup-core.mjs'
import { applyMigration, inCommittedTx, isStaging, loadSupabaseStub, migrationFiles, openDb, readAdaptation, type Db } from './harness'
import { seedUsers } from './fixtures'

const ROOT = join(__dirname, '..', '..', '..')
const MIG_DIR = join(ROOT, 'supabase', 'migrations')
const ADAPT_DIR = join(ROOT, 'supabase', 'adaptations')
const ROLLBACK_DIR = join(ROOT, 'supabase', 'rollback')
const migrations = loadMigrations(MIG_DIR, ADAPT_DIR) as { version: string; name: string; sql: string }[]
const sqlFor = (m: { name: string }) => readFileSync(join(MIG_DIR, m.name), 'utf8')
const v = (n: number) => `202609010000${String(n).padStart(2, '0')}`
const PRESENT = (process.env.REHEARSAL_PRESENT ?? '16').split(',').map((s) => Number(s.trim())).filter(Boolean)
const open: Db[] = []
const tmp: string[] = []
afterAll(async () => {
  for (const d of open) await d.close().catch(() => undefined)
  for (const t of tmp) rmSync(t, { recursive: true, force: true })
})
const rows = (db: Db) => async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows

/** The database the rehearsal expects production to be: 001-014 recorded, plus the in-place migrations. */
async function expectedState(present: number[]) {
  const db = await openDb()
  open.push(db)
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    const n = Number(file.slice(12, 14))
    if (n > 14 && !present.includes(n)) continue
    if (n > 20) continue
    await applyMigration(db, file, '')
    if (n === 17) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  await ensureHistoryTable(db)
  return db
}
async function cleanSignature() {
  const db = await openDb()
  open.push(db)
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    await applyMigration(db, file, file.startsWith('20260901000021') ? readAdaptation('021_before_drop_changed_functions.sql') : '')
    if (file.startsWith('20260901000017')) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  return schemaSignature(rows(db))
}

/** A synthetic "production": production's shape and size, made by hand the way production was (014 + 016, no 015/017-020). */
async function syntheticProduction() {
  const db = await expectedState(PRESENT)
  for (let n = 1; n <= 14; n++) await db.query(`insert into supabase_migrations.schema_migrations (version, name) values ($1, 'x')`, [v(n)])
  await inCommittedTx(db, async () => {
    await seedUsers(db)
    await db.exec(`
      insert into serialized_assets (name, category, serial, status, assigned_to, location)
        select 'Dell ' || (g % 5), 'Laptop', 'INV-' || g, (case when g % 9 = 0 then 'damaged' when g % 7 = 0 then 'retained' else 'available' end)::asset_status, case when g % 11 = 0 then 'Person ' || g else null end, 'Shelf' from generate_series(1, 57) g;
      insert into active_laptops_np (name, category, serial, status, assigned_to, location)
        select 'ThinkPad ' || (g % 6), 'Laptop', 'NP-' || g, 'provided', 'Person ' || (g % 60), 'Remote' from generate_series(1, 114) g;
      insert into active_laptops_np (name, category, serial, status, assigned_to)
        select name, category, ' ' || lower(serial) || ' ', 'provided', 'Person Dup ' || serial from serialized_assets where serial in ('INV-3', 'INV-8', 'INV-13', 'INV-21');
      insert into monitors (name, category, serial, status, location) select 'Dell 24', 'Monitor', 'MON-' || g, (case when g % 4 = 0 then 'provided' else 'available' end)::asset_status, 'Office' from generate_series(1, 31) g;
      insert into serialized_asset_history (asset_id, action, detail) select id, 'created', 'seed' from serialized_assets;
      insert into active_laptops_np_history (asset_id, action, detail) select id, 'provide', 'seed' from active_laptops_np;`)
  })
  return db
}

/** Digest of every pre-existing table over the columns it had in the backup (new columns never count as a change). */
async function originalDigests(db: Db, manifest: { tables: Record<string, { columns: string[] }> }) {
  const out: Record<string, string> = {}
  for (const [t, m] of Object.entries(manifest.tables)) {
    const d = await tableDigest(rows(db), t, m.columns)
    out[t] = `${d.count}:${d.hash}`
  }
  return out
}

async function rehearse(dir: string) {
  const report: string[] = []
  // 1. the backup itself
  const { manifest } = verifyBackupFiles(dir)
  const production: string[] = JSON.parse(readFileSync(join(dir, 'signature.json'), 'utf8'))
  report.push(`backup: ${Object.keys(manifest.tables).length} tables, ${Object.values(manifest.tables as Record<string, { count: number }>).reduce((n, t) => n + t.count, 0)} rows, history ${manifest.migration_history.length}`)

  // 2. the expected database must have production's schema
  const expected = await expectedState(PRESENT)
  const diff = diffSignatures(production, await schemaSignature(rows(expected)))
  expect(diff, 'production schema differs from the expected state (001-014 + ' + PRESENT.join(',') + ')').toEqual({ onlyInProduction: [], onlyInExpected: [] })

  // 3. restore, and prove the copy is faithful
  const restored = await restoreBackup(expected, dir)
  expect(restored.mismatches).toEqual([])
  for (const h of manifest.migration_history as { version: string; name: string }[]) await expected.query(`insert into supabase_migrations.schema_migrations (version, name) values ($1, $2) on conflict do nothing`, [h.version, h.name])
  const before = await originalDigests(expected, manifest)
  expect(Object.keys(before).length).toBe(Object.keys(manifest.tables).length)
  const dupBefore = new Set((await duplicateSerialDetails(rows(expected))).map((r: { key: string }) => r.key))

  // 4. the plan must be the one production reported
  const plan = await planChain(expected, migrations)
  const act = (n: number) => plan.find((p: { version: string }) => p.version === v(n))?.action
  for (const n of [15, 16, 17, 18, 19, 20]) expect(act(n), 'plan for ' + v(n)).toBe(PRESENT.includes(n) ? 'record' : 'apply')
  expect(plan.some((p: { action: string }) => p.action === 'stop')).toBe(false)

  // 5. run the chain; after EVERY step no pre-existing row may have changed
  let afterRecords = ''
  for (let guard = 0; guard < 60; guard++) {
    const next = (await planChain(expected, migrations)).find((p: { action: string }) => p.action === 'record' || p.action === 'apply')
    if (!next) break
    if (next.action === 'record') await recordStep(expected, migrations, next.version)
    else await applyStep(expected, migrations, next.version, { sqlFor, adaptationsDir: ADAPT_DIR })
    const now = await originalDigests(expected, manifest)
    expect(now, `a pre-existing row changed at ${next.version} (${next.action})`).toEqual(before)
    if (next.version === v(28)) afterRecords = JSON.stringify(await schemaSignature(rows(expected)))
  }
  expect((await recordedVersions(expected)).length).toBe(migrations.length)
  // the production compare tool (run after each live step) agrees: every pre-existing table still equals the backup
  await expected.exec('begin read only')
  const cmp = await compareToBackup(rows(expected), dir).finally(() => expected.exec('rollback'))
  expect(cmp.filter((c: { status: string }) => c.status !== 'same')).toEqual([])
  expect(await schemaSignature(rows(expected)), 'final schema must equal a clean build').toEqual(await cleanSignature())
  const dupAfter = (await expected.query<{ n: number }>(`select count(*)::int as n from serial_duplicate_candidates`)).rows[0].n
  expect(dupAfter, 'duplicate serials must be kept and listed').toBeGreaterThan(0)
  report.push(`chain applied; duplicate serial groups before ${dupBefore.size}; candidate rows listed after ${dupAfter}`)

  // 6. rollback: the down scripts in reverse (035 back to 029), rows untouched at every step, schema back to the state just after 028.
  //    Going further back is deliberately not automatic: 029 keeps a private backup table of employee history (a rollback never
  //    deletes data), which blocks dropping 028's types; that would be a deliberate, approved removal. The restore point covers it.
  // The production rollback path itself (apply-core rollbackStep): guards first, then 035..029 one at a time.
  await expect(rollbackStep(expected, v(34), { rollbackDir: ROLLBACK_DIR })).rejects.toThrow(/not the most recently applied/)
  await expect(rollbackStep(expected, v(28), { rollbackDir: ROLLBACK_DIR })).rejects.toThrow(/cannot be rolled back automatically/)
  for (const n of [35, 34, 33, 30, 29]) {
    await rollbackStep(expected, v(n), { rollbackDir: ROLLBACK_DIR })
    expect((await planChain(expected, migrations)).find((p: { version: string }) => p.version === v(n))?.action, `${v(n)} is pending again`).toBe('apply')
    expect(await originalDigests(expected, manifest), `a pre-existing row changed when rolling back ${v(n)}`).toEqual(before)
  }
  expect(JSON.stringify(await schemaSignature(rows(expected))), 'schema after rolling back 035..029 must equal the state just after 028').toBe(afterRecords)
  report.push('rollbacks 035..029 applied in reverse: rows unchanged at every step; schema equals the post-028 state')
  return report
}

describe.skipIf(isStaging)('production backup -> restore -> rehearsal', () => {
  it('the backup tool captures everything: complete, verified, and a restore of it is faithful (synthetic production)', async () => {
    const prod = await syntheticProduction()
    const dir = mkdtempSync(join(tmpdir(), 'ledger-backup-'))
    tmp.push(dir)
    const out = join(dir, 'b')
    await prod.exec('begin read only')
    let summary
    try {
      summary = await exportBackup(rows(prod), { outDir: out, projectRef: 'synthetic' })
    } finally {
      await prod.exec('rollback')
    }
    expect(summary.manifest.tables.serialized_assets.count).toBe(57)
    expect(summary.manifest.tables.active_laptops_np.count).toBe(118)
    expect(summary.manifest.tables.monitors.count).toBe(31)
    // tampering is detected
    const { writeFileSync } = await import('node:fs')
    const original = readFileSync(join(out, 'data.json'))
    writeFileSync(join(out, 'data.json'), original.toString('utf8').replace('INV-1"', 'INV-X"'))
    expect(() => verifyBackupFiles(out)).toThrow(/does not match its recorded SHA-256/)
    writeFileSync(join(out, 'data.json'), original)
    expect(verifyBackupFiles(out).rows).toBeGreaterThan(300)
    // the compare tool sees a changed row
    const restoredCopy = await expectedState(PRESENT)
    await restoreBackup(restoredCopy, out)
    await restoredCopy.exec('begin read only')
    expect((await compareToBackup(rows(restoredCopy), out)).every((c: { status: string }) => c.status === 'same')).toBe(true)
    await restoredCopy.exec('rollback')
    await restoredCopy.exec("update serialized_assets set status = 'damaged' where serial = 'INV-1'")
    await restoredCopy.exec('begin read only')
    expect((await compareToBackup(rows(restoredCopy), out)).filter((c: { status: string }) => c.status === 'changed').map((c: { table: string }) => c.table)).toEqual(['serialized_assets'])
    await restoredCopy.exec('rollback')
    // a restore into the wrong schema is refused, not half-done
    const wrong = await openDb()
    open.push(wrong)
    await loadSupabaseStub(wrong)
    await applyMigration(wrong, migrationFiles()[0], '')
    await expect(restoreBackup(wrong, out)).rejects.toThrow()
  }, 600_000)

  it('the full rehearsal on a backup of the synthetic production (014 + 016; 015, 017-020 missing)', async () => {
    const prod = await syntheticProduction()
    const dir = mkdtempSync(join(tmpdir(), 'ledger-backup-'))
    tmp.push(dir)
    await prod.exec('begin read only')
    try {
      await exportBackup(rows(prod), { outDir: join(dir, 'b'), projectRef: 'synthetic' })
    } finally {
      await prod.exec('rollback')
    }
    const report = await rehearse(join(dir, 'b'))
    console.log('[rehearsal synthetic]\n  ' + report.join('\n  '))
  }, 900_000)

  it.skipIf(!process.env.REHEARSAL_DIR)('the full rehearsal on the REAL production backup (REHEARSAL_DIR)', async () => {
    const report = await rehearse(process.env.REHEARSAL_DIR!)
    console.log('[rehearsal PRODUCTION BACKUP]\n  ' + report.join('\n  '))
  }, 900_000)
})
