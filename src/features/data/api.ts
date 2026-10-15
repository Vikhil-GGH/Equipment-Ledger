import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { Json } from '../../types/database.types'

// Every table a restore can put back. Order doesn't matter for export (it's
// plain parallel SELECTs) but the payload's keys must match exactly what
// restore_backup() reads (supabase/migrations/20260901000020_restore_backup_function.sql).
const BACKUP_TABLES = [
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

// Added by 20260901000026; skipped when the connected database predates it.
const OPTIONAL_BACKUP_TABLES = ['employees', 'equipment_issues'] as const

export interface BackupFile {
  exported_at: string
  tables: Record<(typeof BACKUP_TABLES)[number], unknown[]>
}

export function useExportBackup() {
  return useMutation({
    mutationFn: async (): Promise<BackupFile> => {
      const results = await Promise.all(
        BACKUP_TABLES.map((table) => supabase.from(table).select('*')),
      )
      const tables = {} as BackupFile['tables']
      results.forEach((result, i) => {
        if (result.error) throw result.error
        tables[BACKUP_TABLES[i]] = (result.data ?? []) as unknown[]
      })
      for (const table of OPTIONAL_BACKUP_TABLES) {
        const { data, error } = await supabase.from(table).select('*')
        if (error && (error.code === 'PGRST205' || error.code === '42P01')) continue
        if (error) throw error
        ;(tables as Record<string, unknown[]>)[table] = data ?? []
      }
      return { exported_at: new Date().toISOString(), tables }
    },
  })
}

export function useRestoreBackup() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (backup: BackupFile) => {
      const { error } = await supabase.rpc('restore_backup', {
        p_payload: backup.tables as Json,
      })
      if (error) throw error
    },
    onSuccess: () => {
      // Everything in the ledger just changed at once — simpler and safer
      // to invalidate the whole cache than to enumerate every affected key.
      void queryClient.invalidateQueries()
    },
  })
}
