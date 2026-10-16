import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { fetchAllRows, type PagedSource } from '../../lib/fetchAllRows'
import type { Json } from '../../types/database.types'
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
  OPTIONAL_BACKUP_TABLES,
  restorePayload,
  type BackupFile,
  type BackupTable,
} from './backupFile'

export type { BackupFile } from './backupFile'

const MISSING_TABLE = new Set(['PGRST205', '42P01'])

/**
 * Every row of every table, read page by page and checked against the
 * server's row counts (see fetchAllRows). Any failure throws, so no file is
 * produced from a partial read. Tables are read one after another: a
 * restore needs consistency more than speed.
 */
export async function exportBackup(client: PagedSource): Promise<BackupFile> {
  const tables: BackupFile['tables'] = {}
  const counts: NonNullable<BackupFile['counts']> = {}
  const read = async (table: BackupTable) => {
    const { rows, count } = await fetchAllRows<{ id: string }>(client, table)
    tables[table] = rows
    counts[table] = count
  }
  for (const table of BACKUP_TABLES) await read(table)
  for (const table of OPTIONAL_BACKUP_TABLES) {
    try {
      await read(table)
    } catch (err) {
      if (MISSING_TABLE.has((err as { code?: string }).code ?? '')) continue
      throw err
    }
  }
  return { format_version: BACKUP_FORMAT_VERSION, exported_at: new Date().toISOString(), counts, tables }
}

export function useExportBackup() {
  return useMutation({
    mutationFn: () => exportBackup(supabase as unknown as PagedSource),
  })
}

export interface RestoreResult {
  counts: Record<string, number>
  duplicate_serials: number
  register_mismatches: number
}

export function useRestoreBackup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (backup: BackupFile) => {
      const { data, error } = await supabase.rpc('restore_backup', {
        p_payload: restorePayload(backup) as Json,
      })
      if (error) throw error
      return data as unknown as RestoreResult | null
    },
    onSuccess: () => {
      // Everything in the ledger just changed at once — simpler and safer
      // to invalidate the whole cache than to enumerate every affected key.
      void queryClient.invalidateQueries()
    },
  })
}
