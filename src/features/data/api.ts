import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { PagedSource } from '../../lib/fetchAllRows'
import type { Json } from '../../types/database.types'
import { restorePayload, type BackupFile } from './backupFile'
import { exportBackup } from './exportBackup'

export type { BackupFile } from './backupFile'
export { exportBackup } from './exportBackup'

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
