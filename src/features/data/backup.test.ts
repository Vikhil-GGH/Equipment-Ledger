import { describe, expect, it } from 'vitest'
import { fetchAllRows, IncompleteReadError, type PagedSource } from '../../lib/fetchAllRows'
import { exportBackup } from './api'
import { BACKUP_TABLES, restorePayload, validateBackupFile, type BackupFile } from './backupFile'

type Row = { id: string; [k: string]: unknown }

/**
 * A fake API over in-memory tables that behaves like PostgREST: ordered
 * ranges, an exact count, and a server-side cap of maxRows per response
 * (1,000 on Supabase) regardless of the range asked for.
 */
function fakeApi(
  data: Record<string, Row[]>,
  opts: {
    maxRows?: number
    failOn?: { table: string; call: number; error?: { message: string; code?: string } }
    mutate?: (table: string, call: number) => void
    missing?: string[]
  } = {},
) {
  const calls: { table: string; from: number; to: number }[] = []
  const perTable: Record<string, number> = {}
  const api: PagedSource = {
    from: (table) => ({
      select: () => ({
        order: () => ({
          range: async (from, to) => {
            calls.push({ table, from, to })
            const call = (perTable[table] = (perTable[table] ?? 0) + 1)
            opts.mutate?.(table, call)
            if (opts.missing?.includes(table)) {
              return { data: null, count: null, error: { message: `relation "${table}" does not exist`, code: '42P01' } }
            }
            if (opts.failOn && opts.failOn.table === table && opts.failOn.call === call) {
              return { data: null, count: null, error: opts.failOn.error ?? { message: 'network error' } }
            }
            const rows = [...(data[table] ?? [])].sort((a, b) => a.id.localeCompare(b.id))
            const end = Math.min(to + 1, from + (opts.maxRows ?? 1000))
            return { data: rows.slice(from, end), count: rows.length, error: null }
          },
        }),
      }),
    }),
  }
  return { api, calls }
}

const rows = (n: number, prefix = 'r') =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${String(i).padStart(6, '0')}`, n: i }))

function allTables(sizes: Partial<Record<string, number>> = {}) {
  const data: Record<string, Row[]> = {}
  for (const t of [...BACKUP_TABLES, 'employees', 'equipment_issues']) data[t] = rows(sizes[t] ?? 3, t)
  return data
}

describe('fetchAllRows', () => {
  it('reads a table with more than 1,000 rows completely, in pages', async () => {
    const { api, calls } = fakeApi({ t: rows(2_345) })
    const { rows: got, count } = await fetchAllRows(api, 't')
    expect(count).toBe(2_345)
    expect(got).toHaveLength(2_345)
    expect(new Set(got.map((r) => r.id)).size).toBe(2_345)
    expect(calls.map((c) => c.from)).toEqual([0, 1000, 2000])
  })

  it('does not stop early when the server caps responses below the page size', async () => {
    const { api } = fakeApi({ t: rows(2_500) }, { maxRows: 400 })
    expect((await fetchAllRows(api, 't')).rows).toHaveLength(2_500)
  })

  it('an exact multiple of the page size, and an empty table', async () => {
    const { api, calls } = fakeApi({ t: rows(2_000), e: [] })
    expect((await fetchAllRows(api, 't')).rows).toHaveLength(2_000)
    expect(calls.filter((c) => c.table === 't')).toHaveLength(2)
    expect(await fetchAllRows(api, 'e')).toEqual({ rows: [], count: 0 })
  })

  it('interrupted pagination: a failed page throws — no partial result', async () => {
    const { api } = fakeApi({ t: rows(3_000) }, { failOn: { table: 't', call: 2 } })
    await expect(fetchAllRows(api, 't')).rejects.toThrow(/Could not read all of t: network error/)
  })

  it('a page that comes back empty before the count is reached throws', async () => {
    const data = { t: rows(1_500) }
    const { api } = fakeApi(data, { mutate: (_t, call) => call === 2 && data.t.splice(1000) })
    // The count drops too, so this surfaces as a change during the read.
    await expect(fetchAllRows(api, 't')).rejects.toThrow(IncompleteReadError)
  })

  it('rows added while reading are detected (count changed)', async () => {
    const data = { t: rows(1_500) }
    const { api } = fakeApi(data, { mutate: (_t, call) => call === 2 && data.t.push({ id: 'a-new', n: -1 }) })
    await expect(fetchAllRows(api, 't')).rejects.toThrow(/changed while being read \(1500 → 1501 rows\)/)
  })

  it('a server that reports no count is not trusted', async () => {
    const api: PagedSource = {
      from: () => ({ select: () => ({ order: () => ({ range: async () => ({ data: [], count: null, error: null }) }) }) }),
    }
    await expect(fetchAllRows(api, 't')).rejects.toThrow(/did not report a row count/)
  })

  it('the same row twice (shifted pages) is detected', async () => {
    let call = 0
    const all = rows(1_201)
    const api: PagedSource = {
      from: () => ({
        select: () => ({
          order: () => ({
            // A row inserted before the cursor shifts page 2 back by one,
            // so row 999 arrives again and the last row never does.
            range: async (from) => {
              call++
              return call === 1
                ? { data: all.slice(0, 1000), count: 1_200, error: null }
                : { data: all.slice(from - 1, from + 199), count: 1_200, error: null }
            },
          }),
        }),
      }),
    }
    await expect(fetchAllRows(api, 't')).rejects.toThrow(/arrived twice/)
  })
})

describe('exportBackup', () => {
  it('multiple paginated tables (history, employees, register, imports, checklists): every row of every table, with counts', async () => {
    const sizes = {
      serialized_asset_history: 4_321,
      employees: 1_250,
      equipment_issues: 1_100,
      import_events: 1_001,
      onboarding_checklists: 1_020,
      offboarding_checklists: 1_010,
      serialized_assets: 1_500,
    }
    const data = allTables(sizes)
    data.onboarding_checklists[0] = { ...data.onboarding_checklists[0], charger_required: 'not_applicable', headset_required: null }
    const { api } = fakeApi(data)
    const backup = await exportBackup(api)
    expect(backup.format_version).toBe(2)
    for (const [table, n] of Object.entries(sizes)) {
      expect(backup.tables[table as keyof typeof backup.tables], table).toHaveLength(n)
      expect(backup.counts?.[table as keyof typeof backup.counts], table).toBe(n)
    }
    expect(Object.keys(backup.tables).sort()).toEqual(Object.keys(data).sort())
    expect(backup.tables.onboarding_checklists?.[0]).toMatchObject({ charger_required: 'not_applicable', headset_required: null })
    // Round trip: the file passes its own validation and sends the counts.
    const { verified } = validateBackupFile(JSON.parse(JSON.stringify(backup)))
    expect(verified).toBe(true)
    expect(restorePayload(backup)._counts).toEqual(backup.counts)
  })

  it('a database before 026 (no employees/register tables) still exports the rest', async () => {
    const { api } = fakeApi(allTables(), { missing: ['employees', 'equipment_issues'] })
    const backup = await exportBackup(api)
    expect(Object.keys(backup.tables)).toEqual([...BACKUP_TABLES])
  })

  it('any failure — even late, in a big table — produces no file', async () => {
    const { api } = fakeApi(allTables({ bulk_item_history: 5_000 }), { failOn: { table: 'bulk_item_history', call: 4 } })
    await expect(exportBackup(api)).rejects.toThrow(/bulk_item_history/)
    const denied = fakeApi(allTables(), { failOn: { table: 'employees', call: 1, error: { message: 'permission denied', code: '42501' } } })
    await expect(exportBackup(denied.api)).rejects.toThrow(/permission denied/)
  })
})

describe('validateBackupFile', () => {
  const good = (): BackupFile => {
    const tables = Object.fromEntries(BACKUP_TABLES.map((t) => [t, rows(2, t)])) as BackupFile['tables']
    return { format_version: 2, exported_at: '2026-10-16T00:00:00Z', tables, counts: Object.fromEntries(BACKUP_TABLES.map((t) => [t, 2])) }
  }

  it('accepts a current file', () => {
    expect(validateBackupFile(good())).toMatchObject({ verified: true })
  })

  it('accepts a legacy file (no counts, no employees/register) — marked unverified', () => {
    const legacy = good()
    delete legacy.counts
    delete legacy.format_version
    const r = validateBackupFile(legacy)
    expect(r.verified).toBe(false)
    expect(restorePayload(r.backup)).not.toHaveProperty('_counts')
  })

  it('refuses a file missing rows (no silent omission)', () => {
    const cut = good()
    cut.tables.serialized_asset_history = cut.tables.serialized_asset_history!.slice(1)
    expect(() => validateBackupFile(cut)).toThrow(/incomplete: serialized_asset_history has 1 rows but the export recorded 2/)
  })

  it('refuses a missing table, an unknown table, a non-list, uncounted tables, and newer formats', () => {
    const noMonitors = good()
    delete noMonitors.tables.monitors
    expect(() => validateBackupFile(noMonitors)).toThrow(/monitors/)
    expect(() => validateBackupFile({ ...good(), tables: { ...good().tables, profiles: [] } })).toThrow(/Unknown table "profiles"/)
    expect(() => validateBackupFile({ ...good(), tables: { ...good().tables, monitors: {} } })).toThrow(/not a list/)
    const extra = good()
    extra.tables.employees = []
    expect(() => validateBackupFile(extra)).toThrow(/don't cover "employees"/)
    expect(() => validateBackupFile({ ...good(), format_version: 3 })).toThrow(/newer version/)
    expect(() => validateBackupFile({ tables: [] })).toThrow(/does not look like/)
    expect(() => validateBackupFile(null)).toThrow(/does not look like/)
  })
})
