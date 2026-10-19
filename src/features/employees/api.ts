import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { fetchAllRows, type PagedSource } from '../../lib/fetchAllRows'
import type { EmploymentStatus, Json } from '../../types/database.types'
import type { DirectoryEmployee } from './directoryModel'
import type { EmployeeFields } from './employeeImport'

const client = () => supabase as unknown as PagedSource

/**
 * Whether the connected database has the Active Employees directory
 * (20260901000028). Before it, the page explains that instead of failing.
 */
export function useDirectoryAvailable() {
  return useQuery({
    queryKey: ['employees', 'available'],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const { error } = await supabase.from('employee_history').select('id', { head: true, count: 'exact' }).limit(1)
      if (!error) return true
      if (error.code === 'PGRST205' || error.code === '42P01' || /does not exist|could not find the table/i.test(error.message)) return false
      throw error
    },
  })
}

/** Every employee (paged — no 1,000-row cap). Filtering happens on screen and in the export. */
export function useEmployeeDirectory(enabled = true) {
  return useQuery({
    queryKey: ['employees', 'directory'],
    enabled,
    queryFn: async () => (await fetchAllRows<DirectoryEmployee>(client(), 'employees')).rows,
  })
}

export interface HistoryEntry {
  id: string
  kind: 'created' | 'status' | 'details' | 'reactivation_pending'
  from_status: EmploymentStatus | null
  to_status: EmploymentStatus | null
  changes: Record<string, [string | null, string | null]> | null
  source: string
  note: string | null
  import_filename: string | null
  at: string
}

export function useEmployeeHistory(employeeId: string | undefined) {
  return useQuery({
    queryKey: ['employees', 'history', employeeId],
    enabled: !!employeeId,
    queryFn: async () => {
      const { data, error } = await supabase.from('employee_history').select('*').eq('employee_id', employeeId!).order('at', { ascending: false })
      if (error) throw error
      return data as unknown as HistoryEntry[]
    },
  })
}

/** Register rows still with the employee (open) — shown, never changed, here. */
export function useOpenEquipmentCount(employeeId: string | undefined) {
  return useQuery({
    queryKey: ['register', 'open-count', employeeId],
    enabled: !!employeeId,
    queryFn: async () => {
      const { count, error } = await supabase.from('equipment_issues').select('id', { head: true, count: 'exact' }).eq('employee_id', employeeId!).eq('status', 'open')
      if (error) throw error
      return count ?? 0
    },
  })
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['employees'] })
    // Onboarding/Offboarding employee pickers read the same records.
    void queryClient.invalidateQueries({ queryKey: ['register'] })
  }
}

export function useSaveEmployee() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async ({ id, fields }: { id: string | null; fields: Partial<EmployeeFields> }) => {
      const { data, error } = await supabase.rpc('save_employee', { p_employee_id: id, p_fields: fields as unknown as Json })
      if (error) throw error
      return data as string
    },
    onSuccess: invalidate,
  })
}

export function useSetEmploymentStatus() {
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async ({ id, status, note }: { id: string; status: EmploymentStatus; note?: string }) => {
      const { data, error } = await supabase.rpc('set_employment_status', { p_employee_id: id, p_status: status, p_note: note ?? null })
      if (error) throw error
      return data as boolean
    },
    onSuccess: invalidate,
  })
}

export interface EmployeeImportResult {
  created: number
  updated: number
  unchanged: number
  status_changes: number
  conflicts: { row: number; reason: string; employee_id?: string }[]
}

export function useCommitEmployeeImport() {
  const invalidate = useInvalidate()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ filename, rows }: { filename: string; rows: unknown[] }) => {
      const { data, error } = await supabase.rpc('commit_employee_import', { p_filename: filename, p_rows: rows as Json })
      if (error) throw error
      return data as unknown as EmployeeImportResult
    },
    onSuccess: () => {
      invalidate()
      void queryClient.invalidateQueries({ queryKey: ['import'] })
    },
  })
}
