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
  // True from the moment Supabase reports a PASSWORD_RECOVERY auth event —
  // whether that came from our own in-app code entry or from someone
  // clicking a Supabase recovery link — until the password is actually
  // changed (or they back out and sign out of the recovery session). While
  // true, the app must show the "choose a new password" screen instead of
  // whatever route they landed on, otherwise a recovery session gets treated
  // as an ordinary sign-in and drops them straight into the app.
  isPasswordRecovery: boolean
  clearPasswordRecovery: () => void
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

export const AuthContext = createContext<AuthContextValue | null>(null)
