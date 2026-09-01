import { createContext } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import type { UserRole } from '../../types/database.types'

export interface Profile {
  id: string
  email: string
  full_name: string | null
  role: UserRole
}

export interface AuthContextValue {
  session: Session | null
  user: User | null
  profile: Profile | null
  role: UserRole | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)
