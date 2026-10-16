import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { AssetCollection, AssetStatus, UserRole } from '../../types/database.types'

export interface ProfileRow {
  id: string
  email: string
  full_name: string | null
  role: UserRole
  created_at: string
}

export function useUsersList() {
  return useQuery({
    queryKey: ['admin', 'users'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, email, full_name, role, created_at')
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
      const { error } = await supabase.from('profiles').update({ role }).eq('id', userId)
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] })
    },
  })
}

/**
 * "Remove" a user by deleting their profile row, not their auth.users
 * account — the client SDK can't do the latter (that needs the
 * service-role key, which must never reach the browser). Once a user has
 * no profile, is_known_user() is false and every RLS policy in the app
 * denies them — they can still authenticate but can't reach any data.
 */
export function useRemoveUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await supabase.from('profiles').delete().eq('id', userId)
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
