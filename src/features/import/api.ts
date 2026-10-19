import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { AssetCollection, Json } from '../../types/database.types'
import type { NormalizedAssetImportRow, NormalizedBulkImportRow } from '../../lib/importValidation'
import { fetchAllRows, type PagedSource } from '../../lib/fetchAllRows'
import { normalizeSerial } from '../../lib/serial'

const LAPTOP_TABLES: AssetCollection[] = ['serialized_assets', 'active_laptops_np']

/** One reported row of an asset import (commit_asset_import, 20260901000027). */
export interface AssetImportIssue {
  row: number
  serial: string
  kind: 'rejected' | 'not_applied'
  reason: string
  collection?: AssetCollection
  asset_id?: string
  field?: 'status' | 'assigned_to'
  current?: string | null
  requested?: string
}

export interface AssetImportResult {
  created: number
  updated: number
  unchanged: number
  rejected: number
  issues: AssetImportIssue[]
}

// NormalizedAssetImportRow/NormalizedBulkImportRow are plain string/number
// records but, as named interfaces, don't structurally satisfy the `Json`
// index-signature type this TypeScript version requires (see the comment
// in src/types/database.types.ts) — an explicit cast is correct here since
// every field really is JSON-safe.
function toJson<T>(rows: T[]): Json {
  return rows as unknown as Json
}

/**
 * Existing serials (normalized, src/lib/serial.ts) for the preview's
 * create-vs-existing label. The two laptop tables are one serial space — a
 * laptop moved to Active Laptops is still "existing" for a Laptop
 * Inventory import — and every row is read (paged). The authoritative
 * match happens server-side at commit time regardless.
 */
export function useExistingSerials(collection: AssetCollection, enabled = true) {
  return useQuery({
    queryKey: ['import', 'existing-serials', collection],
    enabled,
    queryFn: async () => {
      const tables: AssetCollection[] = LAPTOP_TABLES.includes(collection) ? LAPTOP_TABLES : [collection]
      const keys = new Set<string>()
      for (const table of tables) {
        const { rows } = await fetchAllRows<{ id: string; serial: string }>(supabase as unknown as PagedSource, table, {
          columns: 'id, serial',
        })
        for (const r of rows) keys.add(normalizeSerial(r.serial))
      }
      return keys
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
      // Same rule as the database (bulk_item_key): case and spacing ignored.
      const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()
      return new Set(data.map((r) => `${key(r.name)}|||${key(r.category)}`))
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
      return data as unknown as AssetImportResult
    },
    onSuccess: () => {
      // A Laptop Inventory import can update a laptop in either laptop table.
      for (const table of LAPTOP_TABLES.includes(collection) ? LAPTOP_TABLES : [collection]) {
        void queryClient.invalidateQueries({ queryKey: ['assets', table] })
      }
      void queryClient.invalidateQueries({ queryKey: ['stats', collection] })
      void queryClient.invalidateQueries({ queryKey: ['import'] })
    },
  })
}

/** commit_bulk_import (20260901000029): a delivery; the same content twice is reported, not added. */
export interface BulkImportResult {
  created: number
  updated: number
  unchanged?: number
  /** Set when this exact content was already imported — nothing was added. */
  duplicate_of?: { filename: string; imported_at: string; imported_by: string | null }
  repeat_of?: string | null
}

export function useCommitBulkImport() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ filename, rows, confirmRepeat = false }: { filename: string; rows: NormalizedBulkImportRow[]; confirmRepeat?: boolean }) => {
      const { data, error } = await supabase.rpc('commit_bulk_import', {
        p_filename: filename,
        p_rows: toJson(rows),
        ...(confirmRepeat ? { p_confirm_repeat: true } : {}),
      })
      if (error) throw error
      return data as unknown as BulkImportResult
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
