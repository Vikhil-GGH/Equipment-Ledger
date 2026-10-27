/**
 * Rehearsal of the reviewed assignment change list on a restored copy of the REAL production backup (disposable database).
 * Opt-in:  REHEARSAL_DIR=<backup folder>  CHANGE_LIST=<change-list.json>  REHEARSAL_PRESENT=16
 * Restores the backup, applies the migration chain, then applies every validated change through the app's own function
 * (scripts/production/assignment-core.mjs, the code the owner runs; perform_lifecycle_action 'provide' as the real admin) and proves: exactly those devices changed, to exactly the planned
 * assignee, with a history entry each; nothing else changed; duplicates, monitors and everything else are untouched.
 * Output is counts only.
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs modules
import { loadMigrations } from '../../../scripts/production/preflight-checks.mjs'
// @ts-expect-error
import { applyStep, ensureHistoryTable, planChain, recordStep } from '../../../scripts/production/apply-core.mjs'
// @ts-expect-error
import { applyAssignments } from '../../../scripts/production/assignment-core.mjs'
// @ts-expect-error
import { restoreBackup, verifyBackupFiles } from '../../../scripts/production/backup-core.mjs'
import { applyMigration, inCommittedTx, loadSupabaseStub, migrationFiles, openDb, readAdaptation, type Db } from './harness'

const ROOT = join(__dirname, '..', '..', '..')
const MIG_DIR = join(ROOT, 'supabase', 'migrations')
const ADAPT_DIR = join(ROOT, 'supabase', 'adaptations')
const migrations = loadMigrations(MIG_DIR, ADAPT_DIR) as { version: string; name: string; sql: string }[]
const sqlFor = (m: { name: string }) => readFileSync(join(MIG_DIR, m.name), 'utf8')
const v = (n: number) => `202609010000${String(n).padStart(2, '0')}`
const PRESENT = (process.env.REHEARSAL_PRESENT ?? '16').split(',').map((s) => Number(s.trim())).filter(Boolean)
const open: Db[] = []
afterAll(async () => { for (const d of open) await d.close().catch(() => undefined) })

async function expectedState() {
  const db = await openDb()
  open.push(db)
  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    const n = Number(file.slice(12, 14))
    if (n > 14 && !PRESENT.includes(n)) continue
    if (n > 20) continue
    await applyMigration(db, file, '')
    if (n === 17) await inCommittedTx(db, () => db.exec(readAdaptation('017_after_role_cast.sql')))
  }
  await ensureHistoryTable(db)
  return db
}

describe.skipIf(!process.env.REHEARSAL_DIR || !process.env.CHANGE_LIST)('assignment change list on the restored production backup', () => {
  it('applies exactly the validated changes and nothing else', async () => {
    const dir = process.env.REHEARSAL_DIR!
    const plan = JSON.parse(readFileSync(process.env.CHANGE_LIST!, 'utf8')) as { changes: { serial: string; production_table: string; production_id: string; new_assignee: string }[] }
    verifyBackupFiles(dir)
    const db = await expectedState()
    expect((await restoreBackup(db, dir)).mismatches).toEqual([])
    for (const h of JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).migration_history as { version: string; name: string }[])
      await db.query(`insert into supabase_migrations.schema_migrations (version, name) values ($1, $2) on conflict do nothing`, [h.version, h.name])
    for (let g = 0; g < 60; g++) {
      const next = (await planChain(db, migrations)).find((p: { action: string }) => p.action === 'record' || p.action === 'apply')
      if (!next) break
      if (next.action === 'record') await recordStep(db, migrations, next.version)
      else await applyStep(db, migrations, next.version, { sqlFor, adaptationsDir: ADAPT_DIR })
    }
    // The production database has exactly one real admin (restored from the backup): the applier acts as that account.
    const snap = async () => {
      const out: Record<string, unknown[]> = {}
      for (const t of ['serialized_assets', 'active_laptops_np', 'monitors']) out[t] = (await db.query(`select id, serial, status, assigned_to, name, location from ${t} order by id`)).rows
      return out
    }
    const before = await snap()
    const ids = new Set(plan.changes.map((c) => c.production_id))
    // The guard rails first: a wrong expected count and a stale row are refused, and nothing changes.
    await expect(applyAssignments(db, plan, { expectCount: plan.changes.length + 1 })).rejects.toThrow(/expected/)
    await expect(applyAssignments(db, { changes: [{ ...plan.changes[0], serial: 'CND4420J3Z' }] }, { expectCount: 1 })).rejects.toThrow(/exclusion/)
    expect(await snap()).toEqual(before)
    // Dry run (default): does everything, then rolls back.
    const dry = await applyAssignments(db, plan, { expectCount: plan.changes.length })
    expect(dry.committed).toBe(false)
    expect(await snap()).toEqual(before)
    // Execute: commits.
    const run = await applyAssignments(db, plan, { expectCount: plan.changes.length, execute: true })
    expect(run.committed).toBe(true)
    // A second run is refused: those devices have already moved or are no longer available.
    await expect(applyAssignments(db, plan, { expectCount: plan.changes.length, execute: true })).rejects.toThrow(/not found|no longer available/)

    const after = await snap()
    const all = (s: Record<string, any[]>) => Object.values(s).flat() as { id: string; serial: string; status: string; assigned_to: string | null }[]
    const byId = new Map(all(after).map((r) => [r.id, r]))
    const respelled: string[] = []
    for (const c of plan.changes) {
      const r = byId.get(c.production_id)!
      expect(r, c.serial + ' still exists').toBeTruthy()
      // the database reuses an already-recorded spelling of the same name (migration 033); only case may differ
      expect([r.status, (r.assigned_to ?? '').toLowerCase()], c.serial).toEqual(['provided', c.new_assignee.toLowerCase()])
      if (r.assigned_to !== c.new_assignee) respelled.push(c.serial + ': "' + c.new_assignee + '" -> "' + r.assigned_to + '"')
    }
    // every other device is identical
    const beforeById = new Map(all(before).map((r) => [r.id, r]))
    for (const r of all(after)) if (!ids.has(r.id)) expect(r, 'untouched ' + r.serial).toEqual(beforeById.get(r.id))
    expect(all(after).length).toBe(all(before).length)
    // the applier itself checked one 'provide' history entry per change inside its transaction
    const hist = plan.changes.length
    const dups = (await db.query<{ n: number }>(`select count(*)::int n from serial_duplicate_candidates`)).rows[0].n
    console.log(`[assignment rehearsal] ${plan.changes.length} applied; devices total ${all(after).length} (unchanged); history entries ${hist}; respelled: ${respelled.join(" | ") || "none"}; duplicate-candidate rows ${dups}`)
  }, 900_000)
})
