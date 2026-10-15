import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { AssetCollection, AssetStatus } from '../../types/database.types'

export interface OffboardingRow {
  id: string
  employee_name: string
  removed_access: boolean
  laptop_received: boolean
  laptop_retained: boolean
  laptop_decommissioned: boolean
  created_at: string
  updated_at: string
}

export function useOffboardingList(search?: string) {
  return useQuery({
    queryKey: ['offboarding', 'list', search ?? ''],
    queryFn: async () => {
      let query = supabase
        .from('offboarding_checklists')
        .select('*')
        .order('created_at', { ascending: false })
      if (search && search.trim()) {
        query = query.ilike('employee_name', `%${search.trim()}%`)
      }
      const { data, error } = await query
      if (error) throw error
      return data as OffboardingRow[]
    },
  })
}

export function useOffboarding(id: string | undefined) {
  return useQuery({
    queryKey: ['offboarding', 'detail', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('offboarding_checklists')
        .select('*')
        .eq('id', id!)
        .single()
      if (error) throw error
      return data as OffboardingRow
    },
  })
}

export function useCreateOffboarding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ employeeName, createdBy }: { employeeName: string; createdBy: string }) => {
      const { data, error } = await supabase
        .from('offboarding_checklists')
        .insert({ employee_name: employeeName, created_by: createdBy })
        .select('id')
        .single()
      if (error) throw error
      return data.id as string
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['offboarding', 'list'] })
    },
  })
}

/** The offboarding checklist steps, in display order. */
export const OFFBOARDING_STEPS = [
  'removed_access',
  'laptop_received',
  'laptop_retained',
  'laptop_decommissioned',
] as const
export type OffboardingStep = (typeof OFFBOARDING_STEPS)[number]

export function useUpdateOffboardingStep(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ step, value }: { step: OffboardingStep; value: boolean }) => {
      const { error } = await supabase
        .from('offboarding_checklists')
        .update({ [step]: value } as Partial<Record<OffboardingStep, boolean>>)
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['offboarding', 'detail', id] })
      void queryClient.invalidateQueries({ queryKey: ['offboarding', 'list'] })
    },
  })
}

export interface EmployeeAssetRow {
  id: string
  collection: AssetCollection
  name: string
  serial: string
  status: AssetStatus
  location: string | null
}

/**
 * Scoped to assets CURRENTLY assigned to this employee (the realistic
 * offboarding case — they still hold the device at this point). Assets
 * they held previously and already returned no longer carry assigned_to,
 * so they won't appear here; that's a deliberate scope limit, not a bug.
 */
export function useEmployeeAssets(employeeName: string | undefined) {
  return useQuery({
    queryKey: ['offboarding', 'employee-assets', employeeName],
    enabled: !!employeeName,
    queryFn: async () => {
      const [serialized, activeNp] = await Promise.all([
        supabase
          .from('serialized_assets')
          .select('id,name,serial,status,location')
          .ilike('assigned_to', employeeName!),
        supabase
          .from('active_laptops_np')
          .select('id,name,serial,status,location')
          .ilike('assigned_to', employeeName!),
      ])
      if (serialized.error) throw serialized.error
      if (activeNp.error) throw activeNp.error

      const rows: EmployeeAssetRow[] = [
        ...serialized.data.map((a) => ({ ...a, collection: 'serialized_assets' as const })),
        ...activeNp.data.map((a) => ({ ...a, collection: 'active_laptops_np' as const })),
      ]
      return rows
    },
  })
}
