// What a backup file holds, and the checks run on it before a restore.

// Every table a restore can put back. The payload's keys must match exactly
// what restore_backup() reads (supabase/migrations/20260901000026_… and
// 20260901000027_inventory_integrity.sql).
export const BACKUP_TABLES = [
  'serialized_assets',
  'active_laptops_np',
  'monitors',
  'other_equipment',
  'bulk_items',
  'serialized_asset_history',
  'active_laptops_np_history',
  'monitors_history',
  'other_equipment_history',
  'bulk_item_history',
  'onboarding_checklists',
  'offboarding_checklists',
  'import_events',
] as const

// Added by 20260901000026 / 028 / 029; skipped when the connected database predates them.
export const OPTIONAL_BACKUP_TABLES = ['employees', 'equipment_issues', 'employee_history', 'bulk_import_receipts'] as const

export type BackupTable = (typeof BACKUP_TABLES)[number] | (typeof OPTIONAL_BACKUP_TABLES)[number]
const KNOWN = new Set<string>([...BACKUP_TABLES, ...OPTIONAL_BACKUP_TABLES])

/** Files written since row counts were added. Older files have no format_version. */
export const BACKUP_FORMAT_VERSION = 2

export interface BackupFile {
  format_version?: number
  exported_at: string
  /** Rows per table, verified against the server's count at export time. */
  counts?: Partial<Record<BackupTable, number>>
  tables: Partial<Record<BackupTable, unknown[]>>
}

export class InvalidBackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidBackupError'
  }
}

/**
 * Checks a parsed file before anything is sent to the server. A file with
 * counts must contain exactly that many rows in each table (catches a file
 * that was cut short or edited); an older file without counts is accepted
 * as before, and the restore then can't verify completeness.
 */
export function validateBackupFile(parsed: unknown): {
  backup: BackupFile
  counts: Record<string, number>
  verified: boolean
} {
  const notBackup = 'This file does not look like an Equipment Ledger backup.'
  if (!parsed || typeof parsed !== 'object') throw new InvalidBackupError(notBackup)
  const file = parsed as Partial<BackupFile>
  if (!file.tables || typeof file.tables !== 'object' || Array.isArray(file.tables)) throw new InvalidBackupError(notBackup)
  if (typeof file.format_version === 'number' && file.format_version > BACKUP_FORMAT_VERSION) {
    throw new InvalidBackupError('This backup was made by a newer version of the app and cannot be restored here.')
  }

  const counts: Record<string, number> = {}
  for (const [table, rows] of Object.entries(file.tables)) {
    if (!KNOWN.has(table)) throw new InvalidBackupError(`Unknown table "${table}" in this backup.`)
    if (!Array.isArray(rows)) throw new InvalidBackupError(`"${table}" in this backup is not a list of rows.`)
    counts[table] = rows.length
  }
  for (const table of BACKUP_TABLES) {
    if (!(table in counts)) throw new InvalidBackupError(`This backup has no "${table}" table — it may be damaged.`)
  }

  const verified = file.counts !== undefined
  if (verified) {
    const expected = file.counts
    if (!expected || typeof expected !== 'object') throw new InvalidBackupError('This backup\'s row counts are damaged.')
    for (const [table, n] of Object.entries(expected)) {
      if (!KNOWN.has(table)) throw new InvalidBackupError(`Unknown table "${table}" in this backup's row counts.`)
      if (counts[table] !== n) {
        throw new InvalidBackupError(
          `This backup is incomplete: ${table} has ${counts[table] ?? 0} rows but the export recorded ${n}. Do not restore it.`,
        )
      }
    }
    for (const table of Object.keys(counts)) {
      if (!(table in expected)) throw new InvalidBackupError(`This backup's row counts don't cover "${table}" — it may be damaged.`)
    }
  }
  return { backup: file as BackupFile, counts, verified }
}

/** What restore_backup() receives: the tables, plus the counts to check. */
export function restorePayload(backup: BackupFile): Record<string, unknown> {
  return backup.counts ? { ...backup.tables, _counts: backup.counts } : { ...backup.tables }
}
