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
// Every other collection follows the regular <collection>_history pattern.
function historyTable(collection: AssetCollection) {
  switch (collection) {
    case 'serialized_assets':
      return 'serialized_asset_history' as const
    case 'active_laptops_np':
      return 'active_laptops_np_history' as const
    case 'monitors':
      return 'monitors_history' as const
    case 'other_equipment':
      return 'other_equipment_history' as const
  }
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
      const { data, error } = await supabase.rpc('perform_lifecycle_action', {
        p_collection: collection,
        p_asset_id: assetId,
        p_action: action,
        p_assigned_to: assignedTo ?? null,
        p_detail: detail ?? null,
      })
      if (error) throw error
      // Provide/Collect/Decommission can move a laptop between Laptop
      // Inventory and Active Laptops (NP) — see
      // supabase/migrations/20260901000021_inventory_active_laptop_moves.sql.
      // The RPC reports back where the asset actually ended up so the
      // caller can redirect off a now-stale URL.
      return data as AssetCollection
    },
    onSuccess: (resultCollection, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['assets', collection, 'list'] })
      void queryClient.invalidateQueries({
        queryKey: ['assets', collection, 'detail', variables.assetId],
      })
      void queryClient.invalidateQueries({
        queryKey: ['assets', collection, 'history', variables.assetId],
      })
      void queryClient.invalidateQueries({ queryKey: ['stats', collection] })
      if (resultCollection !== collection) {
        void queryClient.invalidateQueries({ queryKey: ['assets', resultCollection, 'list'] })
        void queryClient.invalidateQueries({ queryKey: ['stats', resultCollection] })
      }
    },
  })
}

// A laptop provided from Laptop Inventory now lives in Active Laptops (NP)
// until it's collected/decommissioned (see
// supabase/migrations/20260901000021_inventory_active_laptop_moves.sql), so
// the real "available to swap in" pool for Active Laptops (NP) is split
// across both tables — perform_swap already knows how to pick up a
// replacement from either, this just needs to surface both as candidates.
const SWAP_CANDIDATE_COLLECTIONS: Partial<Record<AssetCollection, AssetCollection[]>> = {
  active_laptops_np: ['active_laptops_np', 'serialized_assets'],
}

export function useSwapCandidates(collection: AssetCollection, excludeId: string | undefined) {
  return useQuery({
    queryKey: ['assets', collection, 'swap-candidates', excludeId],
    enabled: !!excludeId,
    queryFn: async () => {
      const collections = SWAP_CANDIDATE_COLLECTIONS[collection] ?? [collection]

      const results = await Promise.all(
        collections.map((c) =>
          supabase
            .from(c)
            .select('id, name, serial, status')
            .in('status', ['available', 'decommissioned'])
            .neq('id', excludeId!),
        ),
      )

      const rows: Pick<AssetRow, 'id' | 'name' | 'serial' | 'status'>[] = []
      for (const result of results) {
        if (result.error) throw result.error
        rows.push(...(result.data as Pick<AssetRow, 'id' | 'name' | 'serial' | 'status'>[]))
      }
      return rows.sort((a, b) => a.serial.localeCompare(b.serial))
    },
  })
}

export interface SwapInput {
  oldAssetId: string
  newAssetId: string
  reason: string
}

export function useSwap(collection: AssetCollection) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ oldAssetId, newAssetId, reason }: SwapInput) => {
      const { data, error } = await supabase.rpc('perform_swap', {
        p_collection: collection,
        p_old_asset_id: oldAssetId,
        p_new_asset_id: newAssetId,
        p_reason: reason,
      })
      if (error) throw error
      // The replacement may have been picked up from the other table (see
      // usePerformLifecycleAction above) — reports back where the
      // swapped-out (old) asset ended up, for the same reason.
      return data as AssetCollection
    },
    onSuccess: (resultCollection, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['assets', collection] })
      void queryClient.invalidateQueries({ queryKey: ['stats', collection] })
      void queryClient.invalidateQueries({
        queryKey: ['assets', collection, 'detail', variables.oldAssetId],
      })
      void queryClient.invalidateQueries({
        queryKey: ['assets', collection, 'detail', variables.newAssetId],
      })
      if (resultCollection !== collection) {
        void queryClient.invalidateQueries({ queryKey: ['assets', resultCollection] })
        void queryClient.invalidateQueries({ queryKey: ['stats', resultCollection] })
      }
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
