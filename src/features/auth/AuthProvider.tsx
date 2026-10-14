import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import type { UserRole } from '../../types/database.types'
import { AuthContext, type Profile } from './auth-context'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false)

  const loadProfile = useCallback(async (userId: string) => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role')
      .eq('id', userId)
      .single()

    if (error) {
      // A missing profile row (e.g. the handle_new_user trigger hasn't run
      // yet in a race) means we genuinely don't know the role — treat as
      // signed-out-of-app-data rather than guessing a role.
      setProfile(null)
      return
    }
    setProfile(data)
  }, [])

  useEffect(() => {
    let cancelled = false

    supabase.auth.getSession().then(async ({ data }) => {
      if (cancelled) return
      const session = data.session
      // No session means signed out — RequireAuth sends the user to /login.
      // Never sign in anonymously: anonymous sessions have no access (see
      // 20260901000022_close_anonymous_access.sql).
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user) {
        await loadProfile(session.user.id)
      }
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange(
      async (event, newSession) => {
        // Fires for both our own verifyOtp(type: 'recovery') call and for
        // Supabase auto-exchanging a clicked recovery link's URL — either
        // way this session must not be treated as a normal sign-in.
        if (event === 'PASSWORD_RECOVERY') {
          setIsPasswordRecovery(true)
        }
        setSession(newSession)
        setUser(newSession?.user ?? null)
        if (newSession?.user) {
          await loadProfile(newSession.user.id)
        } else {
          setProfile(null)
        }
      },
    )

    return () => {
      cancelled = true
      listener.subscription.unsubscribe()
    }
  }, [loadProfile])

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error?.message ?? null }
  }, [])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setIsPasswordRecovery(false)
  }, [])

  const clearPasswordRecovery = useCallback(() => setIsPasswordRecovery(false), [])

  const role: UserRole | null = profile?.role ?? null

  const value = useMemo(
    () => ({
      session,
      user,
      profile,
      role,
      loading,
      isPasswordRecovery,
      clearPasswordRecovery,
      signIn,
      signOut,
    }),
    [session, user, profile, role, loading, isPasswordRecovery, clearPasswordRecovery, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
