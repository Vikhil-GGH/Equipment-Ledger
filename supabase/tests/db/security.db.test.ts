/**
 * Security tests for 20260901000022_close_anonymous_access.sql and
 * 20260901000023_remove_raw_ledger_writes.sql.
 *
 * On PGlite (default) the suite runs in order:
 *   1. baseline: migrations 001-021, a seeded ledger, and proof that the
 *      pre-022 anonymous-access hole is real;
 *   2. apply 022 + 023 and prove existing data is untouched;
 *   3. anonymous sessions have no read or write access at all;
 *   4. every legitimate admin/editor workflow still works;
 *   5. both rollback scripts restore the exact pre-022 definitions, and the
 *      migrations re-apply cleanly afterwards.
 * Against staging (STAGING_DB_URL) only 3 and 4 run, each inside a
 * transaction that is rolled back.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  actAs,
  actAsDatabase,
  applyMigration,
  applyRollback,
  errorOf,
  inCommittedTx,
  inRolledBackTx,
  isStaging,
  loadSupabaseStub,
  migrationFiles,
  readAdaptation,
  openDb,
  tableHash,
  tryQuery,
  type Db,
  type TestUser,
} from './harness'
import {
  ADMIN,
  ANON_LEGACY,
  ANON_NEW,
  ASSET_TABLES,
  EDITOR,
  LEDGER_TABLES,
  STATS_VIEWS,
  VIEWER,
  addAnonymousUser,
  backupTables,
  ensureLegacyAnonymousProfile,
  rpc,
  seedLedger,
  seedLegacyAnonymous,
  seedUsers,
  type LedgerIds,
} from './fixtures'

const SECURITY_MIGRATIONS = [
  '20260901000022_close_anonymous_access.sql',
  '20260901000023_remove_raw_ledger_writes.sql',
]

// Known failures in the migration files, worked around exactly as the
// staging rebuild does (supabase/adaptations/): 021 changes two return
// types with CREATE OR REPLACE (audit C3), and 017 cannot insert a profile
// (text vs user_role) so no user can be created at all.
const C3_WORKAROUND = readAdaptation('021_before_drop_changed_functions.sql')
const WORKING_017_HANDLE_NEW_USER = readAdaptation('017_after_role_cast.sql')

let db: Db
let baselineIds: LedgerIds
const findings: Record<string, string | null> = {}

async function definitionsSnapshot(db: Db) {
  const policies = await db.query(
    `select tablename, policyname, cmd, roles::text, qual, with_check
     from pg_policies where schemaname = 'public' order by tablename, policyname`,
  )
  const functions = await db.query(
    `select p.proname, pg_get_functiondef(p.oid) as def
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' order by p.proname`,
  )
  const triggers = await db.query(
    `select event_object_table, trigger_name, action_statement
     from information_schema.triggers where trigger_schema = 'public'
     order by event_object_table, trigger_name, event_manipulation`,
  )
  return { policies: policies.rows, functions: functions.rows, triggers: triggers.rows }
}

async function dataSnapshot(db: Db) {
  const hashes: Record<string, string> = {}
  for (const t of LEDGER_TABLES) hashes[t] = await tableHash(db, t)
  // profiles minus the two columns 022 is allowed to change on anonymous rows
  const { rows } = await db.query(
    `select md5(string_agg(concat_ws(',', id, email, full_name, created_at), '|' order by id)) as h from profiles`,
  )
  hashes['profiles(id,email,full_name,created_at)'] = rows[0].h as string
  return hashes
}

beforeAll(async () => {
  db = await openDb()
  if (isStaging) return

  await loadSupabaseStub(db)
  for (const file of migrationFiles()) {
    if (SECURITY_MIGRATIONS.includes(file)) continue
    if (file.startsWith('20260901000021')) {
      try {
        await applyMigration(db, file)
        findings.c3 = null
      } catch (err) {
        findings.c3 = err instanceof Error ? err.message : String(err)
        await applyMigration(db, file, C3_WORKAROUND)
      }
      continue
    }
    await applyMigration(db, file)
    if (file.startsWith('20260901000017')) {
      findings.c017 = await (async () => {
        await db.exec('begin')
        try {
          await db.exec(`insert into auth.users (id, is_anonymous) values (gen_random_uuid(), true)`)
          return null
        } catch (err) {
          return err instanceof Error ? err.message : String(err)
        } finally {
          await db.exec('rollback')
        }
      })()
      await inCommittedTx(db, () => db.exec(WORKING_017_HANDLE_NEW_USER))
    }
  }
  baselineIds = await inCommittedTx(db, async () => {
    await seedUsers(db)
    await seedLegacyAnonymous(db)
    return seedLedger(db, 'BASE')
  })
}, 120_000)

afterAll(async () => {
  await db?.close()
})

// ---------------------------------------------------------------- 1. baseline
describe.skipIf(isStaging)('1. baseline before 022 (reproduces the audit findings)', () => {
  it('C3: migration 021 as written fails on a database at 020', () => {
    expect(findings.c3).toMatch(/cannot change return type of existing function/)
  })

  it('017 as written cannot create any new auth user (missing user_role cast)', () => {
    expect(findings.c017).toMatch(/column "role" is of type user_role but expression is of type text/)
  })

  it('C1: a legacy anonymous user was given the editor role', async () => {
    const { rows } = await db.query(`select role from profiles where id = $1`, [ANON_LEGACY.id])
    expect(rows[0].role).toBe('editor')
  })

  it('C1: an anonymous session can read the ledger and change it', async () => {
    await inRolledBackTx(db, async () => {
      await actAs(db, ANON_LEGACY)
      const read = await db.query(`select count(*)::int as n from serialized_assets`)
      expect(read.rows[0].n).toBeGreaterThan(0)
      const raw = await db.query(`update serialized_assets set location = 'tampered' where true`)
      expect(raw.rowCount).toBeGreaterThan(0)
      expect(
        await errorOf(db, `select perform_lifecycle_action('serialized_assets', $1, 'mark_damaged')`, [
          baselineIds.spareInventoryLaptop,
        ]),
      ).toBeNull()
    })
  })

  it('the legacy anonymous user leaves a committed audit reference (must survive 022)', async () => {
    await inCommittedTx(db, async () => {
      await actAs(db, ANON_LEGACY)
      await db.query(`select perform_lifecycle_action('monitors', $1, 'mark_damaged', null, 'anon edit')`, [
        baselineIds.monitor,
      ])
      await actAsDatabase(db)
    })
    const { rows } = await db.query(
      `select count(*)::int as n from monitors_history where actor_user_id = $1`,
      [ANON_LEGACY.id],
    )
    expect(rows[0].n).toBe(1)
  })
})

// -------------------------------------------- 2. apply 022 + 023, keep data
let preDefinitions: Awaited<ReturnType<typeof definitionsSnapshot>>

describe.skipIf(isStaging)('2. applying 022 and 023 preserves every record', () => {
  let before: Record<string, string>

  it('applies both migrations cleanly', async () => {
    preDefinitions = await definitionsSnapshot(db)
    before = await dataSnapshot(db)
    for (const file of SECURITY_MIGRATIONS) await applyMigration(db, file)
  })

  it('leaves every ledger, history, checklist and import row byte-for-byte identical', async () => {
    expect(await dataSnapshot(db)).toEqual(before)
  })

  it('keeps the legacy anonymous profile (audit references stay valid) but pins it to viewer', async () => {
    const { rows } = await db.query(`select role from profiles where id = $1`, [ANON_LEGACY.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].role).toBe('viewer')
    const refs = await db.query(
      `select count(*)::int as n from monitors_history where actor_user_id = $1`,
      [ANON_LEGACY.id],
    )
    expect(refs.rows[0].n).toBe(1)
  })

  it('records the previous anonymous role in the private backup table', async () => {
    const { rows } = await db.query(`select id, role from private.anonymous_role_backup_022`)
    expect(rows).toEqual([{ id: ANON_LEGACY.id, role: 'editor' }])
  })

  it('leaves non-anonymous roles untouched', async () => {
    const { rows } = await db.query<{ id: string; role: string }>(
      `select id, role from profiles where id = any($1) order by id`,
      [[ADMIN.id, EDITOR.id, VIEWER.id]],
    )
    expect(rows.map((r) => r.role)).toEqual(['admin', 'editor', 'viewer'])
  })
})

// --------------------------------------------- 3. anonymous has no access
describe('3. anonymous sessions have no read or write access', () => {
  let ids: LedgerIds

  async function setup() {
    await seedUsers(db)
    await ensureLegacyAnonymousProfile(db)
    await addAnonymousUser(db, ANON_NEW)
    ids = await seedLedger(db, 'ZZ-SECTEST')
  }

  it('a new anonymous user gets no profile row', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      const { rows } = await db.query(`select count(*)::int as n from profiles where id = $1`, [ANON_NEW.id])
      expect(rows[0].n).toBe(0)
    })
  })

  const sessions: [string, TestUser, { omitAnonymousClaim?: boolean }][] = [
    ['legacy anonymous user (has a profile)', ANON_LEGACY, {}],
    ['legacy anonymous user, token without is_anonymous claim', ANON_LEGACY, { omitAnonymousClaim: true }],
    ['new anonymous user (no profile)', ANON_NEW, {}],
  ]

  describe.each(sessions)('%s', (_label, user, opts) => {
    it('reads zero rows from every table, view and the profiles list', async () => {
      await inRolledBackTx(db, async () => {
        await setup()
        await actAs(db, user, opts)
        for (const t of [...LEDGER_TABLES, 'profiles', ...STATS_VIEWS]) {
          const { rows } = await db.query(`select count(*)::int as n from ${t}`)
          expect(rows[0].n, t).toBe(0)
        }
        const bulk = await db.query(`select * from bulk_stock_stats`)
        expect(Object.values(bulk.rows[0]).every((v) => Number(v) === 0)).toBe(true)
        expect(await errorOf(db, `select * from private.anonymous_role_backup_022`)).toMatch(
          /permission denied/,
        )
      })
    })

    it('is rejected by every write function', async () => {
      await inRolledBackTx(db, async () => {
        await setup()
        await actAs(db, user, opts)
        const calls: [string, unknown[]][] = [
          [`create_asset('serialized_assets', 'x', 'Laptop', 'ZZ-ANON-1')`, []],
          [`perform_lifecycle_action('serialized_assets', $1, 'mark_damaged')`, [ids.inventoryLaptop]],
          [`perform_lifecycle_action('active_laptops_np', $1, 'collect')`, [ids.npLaptop]],
          [`perform_swap('active_laptops_np', $1, $2, 'r')`, [ids.npLaptop, ids.spareInventoryLaptop]],
          [`onboarding_assign_device($1, 'ZZ-SECTEST-INV-1')`, [ids.onboarding]],
          [`create_bulk_item('x', 'y')`, []],
          [`perform_bulk_action($1, 'receive_stock', 1)`, [ids.bulkItem]],
          [`commit_asset_import('serialized_assets', 'f.xlsx', '[{"serial":"ZZ-ANON-2","name":"n","category":"c"}]')`, []],
          [`commit_bulk_import('f.xlsx', '[{"name":"n","category":"c","quantity":"1"}]')`, []],
          [`restore_backup('{}'::jsonb)`, []],
        ]
        for (const [call, params] of calls) {
          expect(await errorOf(db, `select ${call}`, params), call).toMatch(/not authorized|only an admin|viewers cannot/i)
        }
      })
    })

    it('cannot insert, update or delete any table directly, and nothing changes', async () => {
      await inRolledBackTx(db, async () => {
        await setup()
        await actAsDatabase(db)
        const before: Record<string, string> = {}
        for (const t of [...LEDGER_TABLES, 'profiles']) before[t] = await tableHash(db, t)

        await actAs(db, user, opts)
        for (const t of ASSET_TABLES) {
          expect(
            await errorOf(db, `insert into ${t} (name, category, serial) values ('x', 'y', 'ZZ-ANON-${t}')`),
            `insert ${t}`,
          ).toMatch(/row-level security/)
        }
        expect(await errorOf(db, `insert into bulk_items (name, category) values ('x', 'y')`)).toMatch(
          /row-level security/,
        )
        expect(
          await errorOf(db, `insert into onboarding_checklists (employee_name) values ('x')`),
        ).toMatch(/row-level security/)
        expect(
          await errorOf(db, `insert into import_events (target_collection, filename) values ('x', 'y')`),
        ).toMatch(/row-level security/)
        expect(
          await errorOf(db, `insert into serialized_asset_history (asset_id, action) values ($1, 'x')`, [
            ids.inventoryLaptop,
          ]),
        ).toMatch(/row-level security/)

        for (const t of [...LEDGER_TABLES, 'profiles']) {
          const upd = await tryQuery(db, `update ${t} set id = id where true`)
          expect('error' in upd ? 0 : upd.rowCount, `update ${t}`).toBe(0)
          const del = await tryQuery(db, `delete from ${t} where true`)
          expect('error' in del ? 0 : del.rowCount, `delete ${t}`).toBe(0)
        }
        const selfPromote = await tryQuery(db, `update profiles set role = 'admin' where id = auth.uid()`)
        expect('error' in selfPromote ? 0 : selfPromote.rowCount).toBe(0)

        await actAsDatabase(db)
        for (const t of [...LEDGER_TABLES, 'profiles']) {
          expect(await tableHash(db, t), t).toBe(before[t])
        }
      })
    })
  })

  it('an admin cannot grant an anonymous user any role above viewer', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAs(db, ADMIN)
      for (const role of ['editor', 'admin', 'scanner']) {
        expect(
          await errorOf(db, `update profiles set role = $2 where id = $1`, [ANON_LEGACY.id, role]),
        ).toMatch(/anonymous users cannot be granted/i)
      }
    })
  })

  it('even a direct database connection cannot give an anonymous user a privileged role', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAsDatabase(db)
      expect(
        await errorOf(db, `update profiles set role = 'editor' where id = $1`, [ANON_LEGACY.id]),
      ).toMatch(/anonymous users cannot be granted/i)
    })
  })
})

// ------------------------------------------------ 4. legitimate workflows
describe('4. legitimate workflows still work', () => {
  let ids: LedgerIds

  async function setup() {
    await seedUsers(db)
    ids = await seedLedger(db, 'ZZ-SECTEST')
  }

  it('admin: lifecycle actions, including the Inventory <-> Active Laptops move', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAs(db, ADMIN)
      const id = ids.inventoryLaptop

      expect(await rpc(db, `perform_lifecycle_action('serialized_assets', $1, 'provide', 'Test Employee C')`, [id])).toBe(
        'active_laptops_np',
      )
      expect(await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'transfer', 'Test Employee D')`, [id])).toBe(
        'active_laptops_np',
      )
      expect(await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'collect')`, [id])).toBe('serialized_assets')

      const row = await db.query(`select status, assigned_to from serialized_assets where id = $1`, [id])
      expect(row.rows[0]).toEqual({ status: 'available', assigned_to: null })
      const hist = await db.query<{ action: string }>(
        `select action from serialized_asset_history where asset_id = $1 order by date, action`,
        [id],
      )
      expect(hist.rows.map((r) => r.action).sort()).toEqual(['collect', 'created', 'provide', 'transfer'])

      await rpc(db, `perform_lifecycle_action('serialized_assets', $1, 'mark_damaged')`, [id])
      await rpc(db, `perform_lifecycle_action('serialized_assets', $1, 'mark_repaired')`, [id])
      await rpc(db, `perform_lifecycle_action('serialized_assets', $1, 'mark_damaged')`, [id])
      await rpc(db, `perform_lifecycle_action('serialized_assets', $1, 'mark_nonfunctional')`, [id])
      expect(
        await errorOf(db, `select perform_lifecycle_action('serialized_assets', $1, 'provide', 'X')`, [id]),
      ).toMatch(/not allowed from status nonfunctional/)
    })
  })

  it('admin: monitors and other equipment lifecycle', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAs(db, ADMIN)
      expect(await rpc(db, `perform_lifecycle_action('monitors', $1, 'provide', 'Test Employee C')`, [ids.monitor])).toBe('monitors')
      expect(await rpc(db, `perform_lifecycle_action('monitors', $1, 'collect')`, [ids.monitor])).toBe('monitors')
      expect(await rpc(db, `perform_lifecycle_action('other_equipment', $1, 'retain')`, [ids.other])).toBe('other_equipment')
    })
  })

  it('admin: swap (replacement picked up from Inventory)', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAs(db, ADMIN)
      await rpc(db, `perform_swap('active_laptops_np', $1, $2, 'cracked screen')`, [ids.npLaptop, ids.spareInventoryLaptop])
      const oldRow = await db.query(`select status, assigned_to from active_laptops_np where id = $1`, [ids.npLaptop])
      expect(oldRow.rows[0]).toEqual({ status: 'damaged', assigned_to: null })
      const newRow = await db.query(`select status, assigned_to from active_laptops_np where id = $1`, [
        ids.spareInventoryLaptop,
      ])
      expect(newRow.rows[0]).toEqual({ status: 'provided', assigned_to: 'Test Employee A' })
    })
  })

  it('admin: asset and bulk imports, and the import log', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAs(db, ADMIN)
      const assets = await rpc<{ created: number }>(
        db,
        `commit_asset_import('monitors', 'monitors.xlsx', $1::jsonb)`,
        [JSON.stringify([{ serial: 'ZZ-SECTEST-MON-2', name: 'Dell 27', category: 'Monitor', status: '', assigned_to: '', location: '' }])],
      )
      expect(assets.created).toBe(1)
      const bulk = await rpc<{ updated: number }>(
        db,
        `commit_bulk_import('bulk.xlsx', $1::jsonb)`,
        [JSON.stringify([{ name: 'Wireless Mouse', category: 'Accessory', location: '', quantity: 5 }])],
      )
      expect(bulk.updated).toBe(1)
      const log = await db.query(`select filename from import_events where filename in ('monitors.xlsx', 'bulk.xlsx')`)
      expect(log.rows).toHaveLength(2)
    })
  })

  it('admin: bulk stock actions', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAs(db, ADMIN)
      await rpc(db, `perform_bulk_action($1, 'issue', 3)`, [ids.bulkItem])
      await rpc(db, `perform_bulk_action($1, 'mark_damaged', 1, 'available')`, [ids.bulkItem])
      const { rows } = await db.query(`select available, provided, damaged from bulk_items where id = $1`, [ids.bulkItem])
      expect(rows[0]).toEqual({ available: 16, provided: 3, damaged: 1 })
    })
  })

  it('admin: onboarding checklist and device assignment', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAs(db, ADMIN)
      const upd = await db.query(`update onboarding_checklists set identity_created = true where id = $1`, [ids.onboarding])
      expect(upd.rowCount).toBe(1)
      await rpc(db, `onboarding_assign_device($1, 'ZZ-SECTEST-INV-1')`, [ids.onboarding])
      const { rows } = await db.query(
        `select equipment_assigned, assigned_asset_id from onboarding_checklists where id = $1`,
        [ids.onboarding],
      )
      expect(rows[0]).toEqual({ equipment_assigned: true, assigned_asset_id: ids.inventoryLaptop })
    })
  })

  it('admin: offboarding checklist and the employee asset lookup', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAs(db, ADMIN)
      const upd = await db.query(`update offboarding_checklists set removed_access = true where id = $1`, [ids.offboarding])
      expect(upd.rowCount).toBe(1)
      const { rows } = await db.query<{ id: string }>(`select id from active_laptops_np where assigned_to ilike 'Test Employee A'`)
      expect(rows.map((r) => r.id)).toContain(ids.npLaptop)
    })
  })

  it('admin: export every table, then restore it, with identical contents', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAsDatabase(db)
      const tables = await backupTables(db)
      const before: Record<string, string> = {}
      for (const t of tables) before[t] = await tableHash(db, t)

      // Export as the Data page does — every row of every table, read as the
      // admin through RLS. Serialized in SQL (to_jsonb) so timestamps keep
      // their microseconds, the way PostgREST returns them to the app.
      await actAs(db, ADMIN)
      const payload: Record<string, unknown> = {}
      for (const t of tables) {
        const { rows } = await db.query<{ rows: unknown }>(
          `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as rows from ${t} t`,
        )
        payload[t] = rows[0].rows
      }
      await rpc(db, `restore_backup($1::jsonb)`, [JSON.stringify(payload)])

      await actAsDatabase(db)
      for (const t of tables) expect(await tableHash(db, t), t).toBe(before[t])
    })
  })

  it('admin: user list and role changes for real accounts', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAs(db, ADMIN)
      const list = await db.query(`select id from profiles where id = any($1)`, [[ADMIN.id, EDITOR.id, VIEWER.id]])
      expect(list.rows).toHaveLength(3)
      const upd = await db.query(`update profiles set role = 'editor' where id = $1`, [VIEWER.id])
      expect(upd.rowCount).toBe(1)
    })
  })

  it('editor: lifecycle via RPC works, raw table writes do not (023)', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAs(db, EDITOR)
      expect(await rpc(db, `perform_lifecycle_action('monitors', $1, 'retain')`, [ids.monitor])).toBe('monitors')
      for (const t of ASSET_TABLES) {
        const upd = await db.query(`update ${t} set status = 'nonfunctional' where true`)
        expect(upd.rowCount, t).toBe(0)
      }
      expect(await errorOf(db, `insert into monitors (name, category, serial) values ('x', 'y', 'ZZ-RAW')`)).toMatch(
        /row-level security/,
      )
    })
  })

  it('admin: raw deletes no longer cascade history away (023)', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAs(db, ADMIN)
      for (const t of [...ASSET_TABLES, 'bulk_items']) {
        const del = await db.query(`delete from ${t} where true`)
        expect(del.rowCount, t).toBe(0)
      }
    })
  })

  it('viewer: can read the ledger, cannot write', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAs(db, VIEWER)
      const { rows } = await db.query(`select count(*)::int as n from serialized_assets`)
      expect(rows[0].n).toBeGreaterThan(0)
      expect(
        await errorOf(db, `select perform_lifecycle_action('monitors', $1, 'retain')`, [ids.monitor]),
      ).toMatch(/viewers cannot/i)
    })
  })

  it('C2: collecting an onboarding-assigned inventory laptop fails before 026 and works after it', async () => {
    await inRolledBackTx(db, async () => {
      await setup()
      await actAs(db, ADMIN)
      await rpc(db, `onboarding_assign_device($1, 'ZZ-SECTEST-INV-1')`, [ids.onboarding])
      expect(
        await errorOf(db, `select perform_lifecycle_action('active_laptops_np', $1, 'collect')`, [ids.inventoryLaptop]),
      ).toEqual(
        // 20260901000026 removed the foreign key that caused C2.
        (await db.query(`select to_regclass('public.equipment_issues') is not null as fixed`)).rows[0].fixed
          ? null
          : expect.stringMatching(/foreign key/),
      )
    })
  })
})

// ----------------------------------------------------------- 5. rollback
describe.skipIf(isStaging)('5. rollback scripts', () => {
  it('023_down then 022_down restore the exact pre-022 policies, functions and triggers', async () => {
    await applyRollback(db, '20260901000023_down.sql')
    await applyRollback(db, '20260901000022_down.sql')
    expect(await definitionsSnapshot(db)).toEqual(preDefinitions)
  })

  it('rolled-back state is the old (vulnerable) behaviour, confirming the rollback is real', async () => {
    await inRolledBackTx(db, async () => {
      await db.query(`update profiles set role = 'editor' where id = $1`, [ANON_LEGACY.id])
      await actAs(db, ANON_LEGACY)
      const { rows } = await db.query(`select count(*)::int as n from serialized_assets`)
      expect(rows[0].n).toBeGreaterThan(0)
    })
  })

  it('022 and 023 re-apply cleanly after a rollback, and close access again', async () => {
    for (const file of SECURITY_MIGRATIONS) await applyMigration(db, file)
    await inRolledBackTx(db, async () => {
      await actAs(db, ANON_LEGACY)
      const { rows } = await db.query(`select count(*)::int as n from serialized_assets`)
      expect(rows[0].n).toBe(0)
    })
  })
})
