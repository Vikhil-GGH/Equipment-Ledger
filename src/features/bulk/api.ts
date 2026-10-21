import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { fetchAllRows, type PagedSource } from '../../lib/fetchAllRows'
import type { BulkAction, BulkBucket } from '../../types/database.types'

export interface BulkItemRow {
  id: string
  name: string
  category: string
  location: string | null
  available: number
  provided: number
  retained: number
  damaged: number
  decommissioned: number
  created_at: string
  updated_at: string
}

export interface BulkItemHistoryRow {
  id: string
  item_id: string
  date: string
  action: string
  detail: string | null
  quantity: number
  actor_user_id: string | null
  actor_email?: string | null
}

export function useBulkItemsList(search?: string) {
  return useQuery({
    queryKey: ['bulk-items', 'list', search ?? ''],
    // Every matching item, read page by page (the API stops at 1,000 per request), by name.
    queryFn: async () => {
      const term = search?.trim()
      const { rows } = await fetchAllRows<BulkItemRow>(supabase as unknown as PagedSource, 'bulk_items', {
        filter: term ? (q) => q.or!(`name.ilike.%${term}%,category.ilike.%${term}%`) : undefined,
      })
      return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    },
  })
}

export function useBulkItem(id: string | undefined) {
  return useQuery({
    queryKey: ['bulk-items', 'detail', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase.from('bulk_items').select('*').eq('id', id!).single()
      if (error) throw error
      return data as BulkItemRow
    },
  })
}

export function useBulkItemHistory(itemId: string | undefined) {
  return useQuery({
    queryKey: ['bulk-items', 'history', itemId],
    enabled: !!itemId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('bulk_item_history')
        .select('*, actor:profiles(email)')
        .eq('item_id', itemId!)
        .order('date', { ascending: false })
      if (error) throw error
      return (data as Array<BulkItemHistoryRow & { actor: { email: string } | null }>).map(
        (row) => ({ ...row, actor_email: row.actor?.email ?? null }),
      )
    },
  })
}

export interface CreateBulkItemInput {
  name: string
  category: string
  location?: string | null
  initialQuantity?: number
}

export function useCreateBulkItem() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateBulkItemInput) => {
      const { data, error } = await supabase.rpc('create_bulk_item', {
        p_name: input.name,
        p_category: input.category,
        p_location: input.location ?? null,
        p_initial_quantity: input.initialQuantity ?? 0,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bulk-items', 'list'] })
      void queryClient.invalidateQueries({ queryKey: ['stats', 'bulk_items'] })
    },
  })
}

export interface PerformBulkActionInput {
  itemId: string
  action: BulkAction
  quantity: number
  fromBucket?: BulkBucket | null
  detail?: string | null
}

export function usePerformBulkAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ itemId, action, quantity, fromBucket, detail }: PerformBulkActionInput) => {
      const { error } = await supabase.rpc('perform_bulk_action', {
        p_item_id: itemId,
        p_action: action,
        p_quantity: quantity,
        p_from_bucket: fromBucket ?? null,
        p_detail: detail ?? null,
      })
      if (error) throw error
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['bulk-items', 'list'] })
      void queryClient.invalidateQueries({ queryKey: ['bulk-items', 'detail', variables.itemId] })
      void queryClient.invalidateQueries({ queryKey: ['bulk-items', 'history', variables.itemId] })
      void queryClient.invalidateQueries({ queryKey: ['stats', 'bulk_items'] })
    },
  })
}

export function useBulkStockStats() {
  return useQuery({
    queryKey: ['stats', 'bulk_items'],
    queryFn: async () => {
      const { data, error } = await supabase.from('bulk_stock_stats').select('*').single()
      if (error) throw error
      return data as {
        available: number
        provided: number
        retained: number
        damaged: number
        decommissioned: number
      }
    },
  })
}
