import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { AssetAction, AssetCollection, AssetStatus } from '../../types/database.types'

export interface AssetRow {
  id: string
  name: string
  category: string
  serial: string
  status: AssetStatus
  assigned_to: string | null
  location: string | null
  created_at: string
  updated_at: string
}

export interface AssetHistoryRow {
  id: string
  asset_id: string
  date: string
  action: string
  detail: string | null
  actor_user_id: string | null
  actor_email?: string | null
}

// serialized_assets' history table is 'serialized_asset_history' (singular
// "asset") — a naming inconsistency from the migration, not a typo here.
function historyTable(collection: AssetCollection) {
  return collection === 'serialized_assets'
    ? ('serialized_asset_history' as const)
    : ('active_laptops_np_history' as const)
}

export function useAssetsList(collection: AssetCollection, search?: string) {
  return useQuery({
    queryKey: ['assets', collection, 'list', search ?? ''],
    queryFn: async () => {
      let query = supabase
        .from(collection)
        .select('*')
        .order('updated_at', { ascending: false })

      if (search && search.trim()) {
        const term = search.trim()
        query = query.or(
          `name.ilike.%${term}%,serial.ilike.%${term}%,assigned_to.ilike.%${term}%`,
        )
      }

      const { data, error } = await query
      if (error) throw error
      return data as AssetRow[]
    },
  })
}

export function useAsset(collection: AssetCollection, id: string | undefined) {
  return useQuery({
    queryKey: ['assets', collection, 'detail', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from(collection)
        .select('*')
        .eq('id', id!)
        .single()
      if (error) throw error
      return data as AssetRow
    },
  })
}

export function useAssetHistory(collection: AssetCollection, assetId: string | undefined) {
  return useQuery({
    queryKey: ['assets', collection, 'history', assetId],
    enabled: !!assetId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from(historyTable(collection))
        .select('*, actor:profiles(email)')
        .eq('asset_id', assetId!)
        .order('date', { ascending: false })
      if (error) throw error
      return (data as Array<AssetHistoryRow & { actor: { email: string } | null }>).map((row) => ({
        ...row,
        actor_email: row.actor?.email ?? null,
      }))
    },
  })
}

export interface CreateAssetInput {
  name: string
  category: string
  serial: string
  status?: AssetStatus
  assigned_to?: string | null
  location?: string | null
}

export function useCreateAsset(collection: AssetCollection) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateAssetInput) => {
      const { data, error } = await supabase.rpc('create_asset', {
        p_collection: collection,
        p_name: input.name,
        p_category: input.category,
        p_serial: input.serial,
        p_status: input.status ?? 'available',
        p_assigned_to: input.assigned_to ?? null,
        p_location: input.location ?? null,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['assets', collection, 'list'] })
    },
  })
}

export interface PerformActionInput {
  assetId: string
  action: AssetAction
  assignedTo?: string | null
  detail?: string | null
}

export function usePerformLifecycleAction(collection: AssetCollection) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ assetId, action, assignedTo, detail }: PerformActionInput) => {
      const { error } = await supabase.rpc('perform_lifecycle_action', {
        p_collection: collection,
        p_asset_id: assetId,
        p_action: action,
        p_assigned_to: assignedTo ?? null,
        p_detail: detail ?? null,
      })
      if (error) throw error
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['assets', collection, 'list'] })
      void queryClient.invalidateQueries({
        queryKey: ['assets', collection, 'detail', variables.assetId],
      })
      void queryClient.invalidateQueries({
        queryKey: ['assets', collection, 'history', variables.assetId],
      })
      void queryClient.invalidateQueries({ queryKey: ['stats', collection] })
    },
  })
}

export function useAssetStats(collection: AssetCollection) {
  return useQuery({
    queryKey: ['stats', collection],
    queryFn: async () => {
      const { data, error } = await supabase.from(`${collection}_stats`).select('*')
      if (error) throw error
      return data as { status: AssetStatus; count: number }[]
    },
  })
}
