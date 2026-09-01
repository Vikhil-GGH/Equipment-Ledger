import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { AssetCollection, Json } from '../../types/database.types'
import type { NormalizedAssetImportRow, NormalizedBulkImportRow } from '../../lib/importValidation'

// NormalizedAssetImportRow/NormalizedBulkImportRow are plain string/number
// records but, as named interfaces, don't structurally satisfy the `Json`
// index-signature type this TypeScript version requires (see the comment
// in src/types/database.types.ts) — an explicit cast is correct here since
// every field really is JSON-safe.
function toJson<T>(rows: T[]): Json {
  return rows as unknown as Json
}

/**
 * All existing serials for a collection, fetched once per import session
 * to classify rows as create-vs-update in the preview. Fine for an
 * internal-tool inventory (hundreds to low thousands of rows); the
 * authoritative match still happens server-side at commit time regardless.
 */
export function useExistingSerials(collection: AssetCollection, enabled = true) {
  return useQuery({
    queryKey: ['import', 'existing-serials', collection],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.from(collection).select('serial')
      if (error) throw error
      return new Set(data.map((r) => r.serial.toLowerCase()))
    },
  })
}

export function useExistingBulkItemKeys(enabled = true) {
  return useQuery({
    queryKey: ['import', 'existing-bulk-keys'],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.from('bulk_items').select('name, category')
      if (error) throw error
      return new Set(data.map((r) => `${r.name.toLowerCase()}|||${r.category.toLowerCase()}`))
    },
  })
}

export function useCommitAssetImport(collection: AssetCollection) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      filename,
      rows,
    }: {
      filename: string
      rows: NormalizedAssetImportRow[]
    }) => {
      const { data, error } = await supabase.rpc('commit_asset_import', {
        p_collection: collection,
        p_filename: filename,
        p_rows: toJson(rows),
      })
      if (error) throw error
      return data as { created: number; updated: number }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['assets', collection] })
      void queryClient.invalidateQueries({ queryKey: ['stats', collection] })
      void queryClient.invalidateQueries({ queryKey: ['import'] })
    },
  })
}

export function useCommitBulkImport() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ filename, rows }: { filename: string; rows: NormalizedBulkImportRow[] }) => {
      const { data, error } = await supabase.rpc('commit_bulk_import', {
        p_filename: filename,
        p_rows: toJson(rows),
      })
      if (error) throw error
      return data as { created: number; updated: number }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bulk-items'] })
      void queryClient.invalidateQueries({ queryKey: ['stats', 'bulk_items'] })
      void queryClient.invalidateQueries({ queryKey: ['import'] })
    },
  })
}

export interface ImportEventRow {
  id: string
  imported_at: string
  target_collection: string
  filename: string
  rows_created: number
  rows_updated: number
  rows_errored: number
}

export function useImportHistory() {
  return useQuery({
    queryKey: ['import', 'events'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('import_events')
        .select('id, imported_at, target_collection, filename, rows_created, rows_updated, rows_errored')
        .order('imported_at', { ascending: false })
        .limit(50)
      if (error) throw error
      return data as ImportEventRow[]
    },
  })
}
