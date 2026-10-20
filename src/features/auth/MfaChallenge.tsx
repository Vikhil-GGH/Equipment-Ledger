import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { getErrorMessage } from '../../lib/errors'
import { useAuth } from './useAuth'

/**
 * Shown after the password when the account has a verified authenticator:
 * the 6-digit code upgrades the session to two-factor (aal2), which admin
 * powers require (20260901000030).
 */
export function MfaChallenge() {
  const { refreshAal, signOut } = useAuth()
  const [factorId, setFactorId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (error) return setError(getErrorMessage(error, 'Could not load your authenticator'))
      const totp = data?.totp?.find((f) => f.status === 'verified')
      if (totp) setFactorId(totp.id)
      else setError('No verified authenticator found for this account.')
    })
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!factorId) return
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() })
    setBusy(false)
    if (error) return setError(getErrorMessage(error, 'That code did not work — try the current one'))
    await refreshAal()
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-3" aria-label="Two-factor authentication">
        <h1 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">Two-factor authentication</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">Enter the 6-digit code from your authenticator app.</p>
        <input
          className="input font-mono tracking-widest"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          aria-label="Authentication code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          autoFocus
        />
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-between gap-2">
          <button type="button" className="btn-secondary" onClick={() => void signOut()}>
            Sign out
          </button>
          <button type="submit" className="btn-primary" disabled={busy || code.length !== 6 || !factorId}>
            {busy ? 'Checking…' : 'Verify'}
          </button>
        </div>
      </form>
    </div>
  )
}
