import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { AssetCollection, AssetStatus, RequirementAnswer } from '../../types/database.types'
import type { EquipmentIssue, ReturnOutcome } from './registerModel'

/**
 * Whether the connected database has the employee equipment register
 * (20260901000026). The new Onboarding/Offboarding equipment sections only
 * appear when it does; before that the pages keep working exactly as
 * before. "Missing table" is the only answer treated as "not available".
 */
export function useRegisterAvailable() {
  return useQuery({
    queryKey: ['register', 'available'],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const { error } = await supabase.from('employees').select('id', { head: true, count: 'exact' }).limit(1)
      if (!error) return true
      if (error.code === 'PGRST205' || error.code === '42P01' || /does not exist|could not find the table/i.test(error.message)) {
        return false
      }
      throw error
    },
  })
}

export interface Employee {
  id: string
  full_name: string
  name_key: string | null
  created_at: string
}

export function useEmployeesNamed(nameKey: string | null) {
  return useQuery({
    queryKey: ['register', 'employees', 'named', nameKey],
    enabled: !!nameKey,
    queryFn: async () => {
      const { data, error } = await supabase.from('employees').select('id, full_name, name_key, created_at').eq('name_key', nameKey!)
      if (error) throw error
      return data as Employee[]
    },
  })
}

export function useEmployee(id: string | null | undefined) {
  return useQuery({
    queryKey: ['register', 'employee', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase.from('employees').select('id, full_name, name_key, created_at').eq('id', id!).single()
      if (error) throw error
      return data as Employee
    },
  })
}

export function usePossibleDuplicates(enabled = true) {
  return useQuery({
    queryKey: ['register', 'possible-duplicates'],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.from('employee_possible_duplicates').select('*')
      if (error) throw error
      return data as { employee_id: string; full_name: string; other_employee_id: string; other_full_name: string; reason: string }[]
    },
  })
}

/** Everything ever issued to the employee — open first, newest first. */
export function useEmployeeIssues(employeeId: string | null | undefined) {
  return useQuery({
    queryKey: ['register', 'issues', employeeId],
    enabled: !!employeeId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('equipment_issues')
        .select('*')
        .eq('employee_id', employeeId!)
        .order('issued_at', { ascending: false })
      if (error) throw error
      const rows = data as EquipmentIssue[]
      return [...rows.filter((r) => r.status === 'open'), ...rows.filter((r) => r.status !== 'open')]
    },
  })
}

/** Devices assigned to this name that the register does not show as with this employee. Normally empty. */
export function useUnregisteredDevices(nameKey: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['register', 'mismatches', nameKey],
    enabled: enabled && !!nameKey,
    queryFn: async () => {
      const { data, error } = await supabase.from('equipment_register_mismatches').select('*')
      if (error) throw error
      const norm = (s: string | null) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
      return (data as { collection: AssetCollection; asset_id: string; serial: string; assigned_to: string | null }[]).filter(
        (r) => norm(r.assigned_to) === nameKey,
      )
    },
  })
}

export interface IssuableDevice {
  id: string
  collection: AssetCollection
  name: string
  serial: string
  status: AssetStatus
  location: string | null
}

/** Devices that can be Provided right now (the same statuses the lifecycle allows). */
export function useIssuableDevices(kind: 'laptop' | 'headset', enabled = true) {
  return useQuery({
    queryKey: ['register', 'issuable', kind],
    enabled,
    queryFn: async () => {
      const tables: AssetCollection[] = kind === 'laptop' ? ['serialized_assets', 'active_laptops_np'] : ['other_equipment']
      const out: IssuableDevice[] = []
      for (const t of tables) {
        let q = supabase.from(t).select('id, name, serial, status, location').in('status', ['available', 'retained', 'decommissioned'])
        if (kind === 'headset') q = q.or('category.ilike.%headset%,name.ilike.%headset%')
        const { data, error } = await q.order('serial')
        if (error) throw error
        out.push(...(data as Omit<IssuableDevice, 'collection'>[]).map((d) => ({ ...d, collection: t })))
      }
      return out
    },
  })
}

export interface BulkCandidate {
  id: string
  name: string
  category: string
  available: number
}

export function useBulkCandidates(kind: 'charger' | 'headset', enabled = true) {
  return useQuery({
    queryKey: ['register', 'bulk-candidates', kind],
    enabled,
    queryFn: async () => {
      const filter = kind === 'charger' ? 'name.ilike.%charger%,category.ilike.%power%,category.ilike.%charger%' : 'name.ilike.%headset%,category.ilike.%headset%'
      const { data, error } = await supabase.from('bulk_items').select('id, name, category, available').or(filter).order('name')
      if (error) throw error
      return data as BulkCandidate[]
    },
  })
}

function invalidateAfterRegisterChange(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of [['register'], ['assets'], ['stats'], ['bulk-items'], ['onboarding'], ['offboarding']]) {
    void queryClient.invalidateQueries({ queryKey: key })
  }
}

export function useCreateEmployee() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (fullName: string) => {
      const { data, error } = await supabase.rpc('create_employee', { p_full_name: fullName })
      if (error) throw error
      return data as string
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['register'] }),
  })
}

export function useLinkChecklistEmployee(table: 'onboarding_checklists' | 'offboarding_checklists', checklistId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (employeeId: string) => {
      const { error } = await supabase.from(table).update({ employee_id: employeeId }).eq('id', checklistId)
      if (error) throw error
    },
    onSuccess: () => invalidateAfterRegisterChange(queryClient),
  })
}

export function useSetOnboardingEquipmentFields(checklistId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (
      fields: Partial<{ requested_laptop: string | null; charger_required: RequirementAnswer | null; headset_required: RequirementAnswer | null }>,
    ) => {
      // Saving an answer is just the answer: it never issues or returns anything.
      const { error } = await supabase.from('onboarding_checklists').update(fields).eq('id', checklistId)
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['onboarding', 'detail', checklistId] })
    },
  })
}

export interface IssueInput {
  employeeId: string
  onboardingId?: string | null
  device?: { collection: AssetCollection; id: string }
  bulk?: { itemId: string; quantity: number }
  note?: string | null
}

export function useIssueEquipment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: IssueInput) => {
      const { data, error } = await supabase.rpc('issue_equipment', {
        p_employee_id: input.employeeId,
        p_collection: input.device?.collection ?? null,
        p_asset_id: input.device?.id ?? null,
        p_bulk_item_id: input.bulk?.itemId ?? null,
        p_quantity: input.bulk?.quantity ?? 1,
        p_onboarding_id: input.onboardingId ?? null,
        p_note: input.note ?? null,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => invalidateAfterRegisterChange(queryClient),
  })
}

export interface ReturnInput {
  issueId: string
  outcome: ReturnOutcome
  quantity?: number | null
  note?: string | null
  offboardingId?: string | null
}

export function useReturnEquipment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: ReturnInput) => {
      const { data, error } = await supabase.rpc('return_equipment', {
        p_issue_id: input.issueId,
        p_outcome: input.outcome,
        p_quantity: input.quantity ?? null,
        p_note: input.note ?? null,
        p_offboarding_id: input.offboardingId ?? null,
      })
      if (error) throw error
      return data as string
    },
    onSuccess: () => invalidateAfterRegisterChange(queryClient),
  })
}

/** Laptops kept by a former employee with approval — shown as such in Laptop Inventory. */
export function useRetainedDeviceIds(enabled: boolean) {
  return useQuery({
    queryKey: ['register', 'retained-devices'],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('equipment_issues')
        .select('asset_id, assignee_name')
        .eq('status', 'retained_authorized')
        .eq('item_kind', 'serialized')
      if (error) throw error
      return data as { asset_id: string; assignee_name: string }[]
    },
  })
}

/** Open (tracked) quantity per bulk item — the rest of Provided predates tracking. */
export function useTrackedBulkQuantity(itemId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['register', 'bulk-tracked', itemId],
    enabled: enabled && !!itemId,
    queryFn: async () => {
      const { data, error } = await supabase.from('equipment_issues').select('quantity').eq('bulk_item_id', itemId!).eq('status', 'open')
      if (error) throw error
      return (data as { quantity: number }[]).reduce((n, r) => n + r.quantity, 0)
    },
  })
}
