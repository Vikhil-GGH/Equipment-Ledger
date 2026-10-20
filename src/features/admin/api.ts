import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { AssetCollection, AssetStatus, UserRole } from '../../types/database.types'

export interface ProfileRow {
  id: string
  email: string
  full_name: string | null
  role: UserRole
  created_at: string
  /** Set when access was removed (20260901000030); absent before it. */
  access_revoked_at?: string | null
  role_before_revoke?: UserRole | null
}

export function useUsersList() {
  return useQuery({
    queryKey: ['admin', 'users'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .order('email', { ascending: true })
      if (error) throw error
      return data as ProfileRow[]
    },
  })
}

export function useUpdateUserRole() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: UserRole }) => {
      const { data, error } = await supabase.from('profiles').update({ role }).eq('id', userId).select('id')
      if (error) throw error
      // Row-level security silently changes nothing for a non-admin (or an
      // admin without two-factor sign-in) — say so instead of pretending.
      if (!data?.length) throw new Error('The role was not changed — admin changes need an admin signed in with two-factor authentication.')
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
    },
  })
}

/**
 * Remove a person's access without deleting them (20260901000030): their
 * role becomes viewer, the previous role is kept, they can no longer read
 * or change anything, and every history entry still names them. Admin
 * only, signed in with two-factor authentication.
 */
export function useRemoveUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, reason }: { userId: string; reason?: string }) => {
      const { error } = await supabase.rpc('revoke_user_access', { p_user_id: userId, p_reason: reason ?? null })
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
    },
  })
}

export function useRestoreUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, reason }: { userId: string; reason?: string }) => {
      const { error } = await supabase.rpc('restore_user_access', { p_user_id: userId, p_reason: reason ?? null })
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
    },
  })
}

export interface SerialDuplicate {
  serial_key: string
  collection: AssetCollection
  asset_id: string
  serial: string
  status: AssetStatus
  assigned_to: string | null
  reason: string
}

/**
 * Devices that already shared a serial (or had none) when serial checks
 * were added (20260901000027). null when the database predates that.
 */
export function useSerialDuplicates() {
  return useQuery({
    queryKey: ['admin', 'serial-duplicates'],
    queryFn: async (): Promise<SerialDuplicate[] | null> => {
      const { data, error } = await supabase
        .from('serial_duplicate_candidates')
        .select('*')
        .order('serial_key')
        .order('collection')
      if (error && (error.code === 'PGRST205' || error.code === '42P01')) return null
      if (error) throw error
      return data as SerialDuplicate[]
    },
  })
}
