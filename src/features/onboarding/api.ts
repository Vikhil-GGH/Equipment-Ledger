import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'

export interface OnboardingRow {
  id: string
  employee_name: string
  identity_created: boolean
  equipment_assigned: boolean
  required_access_provided: boolean
  onboarding_successful: boolean
  assigned_asset_id: string | null
  created_at: string
  updated_at: string
}

export function useOnboardingList(search?: string) {
  return useQuery({
    queryKey: ['onboarding', 'list', search ?? ''],
    queryFn: async () => {
      let query = supabase
        .from('onboarding_checklists')
        .select('*')
        .order('created_at', { ascending: false })
      if (search && search.trim()) {
        query = query.ilike('employee_name', `%${search.trim()}%`)
      }
      const { data, error } = await query
      if (error) throw error
      return data as OnboardingRow[]
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
    mutationFn: async ({ employeeName, createdBy }: { employeeName: string; createdBy: string }) => {
      const { data, error } = await supabase
        .from('onboarding_checklists')
        .insert({ employee_name: employeeName, created_by: createdBy })
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
      void queryClient.invalidateQueries({ queryKey: ['assets', 'active_laptops_np'] })
      void queryClient.invalidateQueries({ queryKey: ['stats', 'active_laptops_np'] })
    },
  })
}
