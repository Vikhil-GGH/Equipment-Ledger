import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { fetchAllRows, type PagedSource } from '../../lib/fetchAllRows'
import type { RequirementAnswer } from '../../types/database.types'

export interface OnboardingRow {
  id: string
  employee_name: string
  identity_created: boolean
  equipment_assigned: boolean
  required_access_provided: boolean
  onboarding_successful: boolean
  assigned_asset_id: string | null
  // Present once the employee register (20260901000026) exists.
  employee_id?: string | null
  requested_laptop?: string | null
  charger_required?: RequirementAnswer | null
  headset_required?: RequirementAnswer | null
  created_at: string
  updated_at: string
}

export function useOnboardingList(search?: string) {
  return useQuery({
    queryKey: ['onboarding', 'list', search ?? ''],
    // Every matching record, read page by page (the API stops at 1,000 per request), newest first.
    queryFn: async () => {
      const term = search?.trim()
      const { rows } = await fetchAllRows<OnboardingRow>(supabase as unknown as PagedSource, 'onboarding_checklists', {
        filter: term ? (q) => q.ilike!('employee_name', `%${term}%`) : undefined,
      })
      return rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
    },
  })
}

export function useOnboarding(id: string | undefined) {
  return useQuery({
    queryKey: ['onboarding', 'detail', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('onboarding_checklists')
        .select('*')
        .eq('id', id!)
        .single()
      if (error) throw error
      return data as OnboardingRow
    },
  })
}

export function useCreateOnboarding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      employeeName,
      createdBy,
      employeeId,
    }: {
      employeeName: string
      createdBy: string
      /** Only sent when the employee register (20260901000026) exists. */
      employeeId?: string | null
    }) => {
      const { data, error } = await supabase
        .from('onboarding_checklists')
        .insert({ employee_name: employeeName, created_by: createdBy, ...(employeeId ? { employee_id: employeeId } : {}) })
        .select('id')
        .single()
      if (error) throw error
      return data.id as string
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['onboarding', 'list'] })
    },
  })
}

/** The four checklist steps, in display order. */
export const ONBOARDING_STEPS = [
  'identity_created',
  'equipment_assigned',
  'required_access_provided',
  'onboarding_successful',
] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export function useUpdateOnboardingStep(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ step, value }: { step: OnboardingStep; value: boolean }) => {
      const { error } = await supabase
        .from('onboarding_checklists')
        .update({ [step]: value } as Partial<Record<OnboardingStep, boolean>>)
        .eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['onboarding', 'detail', id] })
      void queryClient.invalidateQueries({ queryKey: ['onboarding', 'list'] })
    },
  })
}

export function useAssignOnboardingDevice(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      serial: string
      name?: string | null
      category?: string | null
      location?: string | null
    }) => {
      const { data, error } = await supabase.rpc('onboarding_assign_device', {
        p_onboarding_id: id,
        p_serial: input.serial,
        p_name: input.name ?? null,
        p_category: input.category ?? null,
        p_location: input.location ?? null,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['onboarding', 'detail', id] })
      // Assigning ticks "Equipment assigned", so the list's progress changes too.
      void queryClient.invalidateQueries({ queryKey: ['onboarding', 'list'] })
      // An Inventory laptop moves into Active Laptops (NP) when assigned here,
      // so both tables' lists change.
      void queryClient.invalidateQueries({ queryKey: ['assets', 'active_laptops_np'] })
      void queryClient.invalidateQueries({ queryKey: ['assets', 'serialized_assets'] })
      void queryClient.invalidateQueries({ queryKey: ['stats', 'active_laptops_np'] })
      void queryClient.invalidateQueries({ queryKey: ['stats', 'serialized_assets'] })
    },
  })
}
