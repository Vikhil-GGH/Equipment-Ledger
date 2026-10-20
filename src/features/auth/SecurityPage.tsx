import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { getErrorMessage } from '../../lib/errors'
import { useAuth } from './useAuth'

interface Factor {
  id: string
  friendly_name?: string | null
  status: string
  created_at: string
}

/**
 * Two-factor authentication (TOTP) for the signed-in account. Admins need a
 * two-factor session for everything (20260901000030/031); everyone may set
 * it up. Replacing an authenticator verifies the new one BEFORE removing the
 * old, so the account never has none (Supabase also requires a verified
 * session to add or remove a factor once one exists).
 */
export function SecurityPage() {
  const { role, aal, refreshAal } = useAuth()
  const [factors, setFactors] = useState<Factor[] | null>(null)
  const [enrolling, setEnrolling] = useState<{ id: string; qr: string; secret: string; replacing: string[] } | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    () =>
      supabase.auth.mfa.listFactors().then(({ data, error }) => {
        if (error) setError(getErrorMessage(error, 'Could not load your two-factor settings'))
        else setFactors((data?.totp ?? []) as Factor[])
      }),
    [],
  )
  useEffect(() => {
    let active = true
    supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (!active) return
      if (error) setError(getErrorMessage(error, 'Could not load your two-factor settings'))
      else setFactors((data?.totp ?? []) as Factor[])
    })
    return () => {
      active = false
    }
  }, [])

  const verified = (factors ?? []).filter((f) => f.status === 'verified')
  const sessionVerified = aal?.current === 'aal2'

  async function start(replacing: string[] = []) {
    setError(null)
    setMessage(null)
    setBusy(true)
    // An unfinished earlier attempt would block a new one; remove it first.
    for (const f of factors ?? []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id })
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Equipment Ledger ${new Date().toISOString().slice(0, 19)}` })
    setBusy(false)
    if (error || !data) return setError(getErrorMessage(error, 'Could not start setup'))
    setEnrolling({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret, replacing })
  }

  async function removeOld(ids: string[]) {
    for (const id of ids) {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: id })
      if (error) return getErrorMessage(error, 'Could not remove the old authenticator')
    }
    return null
  }

  async function verify(e: FormEvent) {
    e.preventDefault()
    if (!enrolling) return
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolling.id, code: code.trim() })
    if (error) {
      setBusy(false)
      return setError(getErrorMessage(error, 'That code did not work — try the current one'))
    }
    const replaced = enrolling.replacing
    setEnrolling(null)
    setCode('')
    // Only now that the new authenticator works is the old one removed.
    const failure = replaced.length ? await removeOld(replaced) : null
    setBusy(false)
    if (failure) setError(`Your new authenticator is on, but the old one is still active: ${failure}. Use "Remove old authenticators" to try again.`)
    else setMessage(replaced.length ? 'Your new authenticator is on and the old one is removed.' : 'Two-factor authentication is on. You will be asked for a code when you sign in.')
    await refreshAal()
    await load()
  }

  async function removeExtra() {
    setBusy(true)
    setError(null)
    // Keep the newest verified authenticator; never remove the last one.
    const newestFirst = [...verified].sort((a, b) => b.created_at.localeCompare(a.created_at))
    const failure = await removeOld(newestFirst.slice(1).map((f) => f.id))
    setBusy(false)
    if (failure) setError(failure)
    else setMessage('Old authenticators removed.')
    await load()
  }

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Security</h1>
      <section className="card space-y-3" aria-label="Two-factor authentication">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Two-factor authentication</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {verified.length
            ? `On (${sessionVerified ? 'this session is verified' : 'verify at sign-in'}).`
            : 'Off. Use an authenticator app (e.g. Microsoft Authenticator, Google Authenticator, 1Password).'}
          {role === 'admin' && ' Admin accounts need it for everything.'}
        </p>
        {message && <p role="status" className="text-sm text-teal-700 dark:text-teal-400">{message}</p>}
        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {factors && !verified.length && !enrolling && (
          <button type="button" className="btn-primary" onClick={() => void start()} disabled={busy}>
            {busy ? 'Starting…' : 'Set up two-factor authentication'}
          </button>
        )}
        {factors && verified.length > 0 && sessionVerified && !enrolling && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary" onClick={() => void start(verified.map((f) => f.id))} disabled={busy}>
              Replace authenticator (new phone)
            </button>
            {verified.length > 1 && (
              <button type="button" className="btn-secondary" onClick={() => void removeExtra()} disabled={busy}>
                Remove old authenticators
              </button>
            )}
          </div>
        )}
        {enrolling && (
          <form onSubmit={verify} className="space-y-3">
            {enrolling.replacing.length > 0 && (
              <p className="text-sm">Your current authenticator keeps working until the new one is verified.</p>
            )}
            <p className="text-sm">1. Scan this code with your authenticator app (or enter the key below).</p>
            <img src={enrolling.qr} alt="QR code for your authenticator app" className="h-44 w-44 rounded border border-stone-200 bg-white p-2" />
            <p className="break-all font-mono text-xs text-neutral-600 dark:text-neutral-400" aria-label="Setup key">{enrolling.secret}</p>
            <label className="block text-sm">
              2. Enter the 6-digit code it shows
              <input
                className="input mt-1 font-mono tracking-widest"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                aria-label="Authentication code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </label>
            <button type="submit" className="btn-primary" disabled={busy || code.length !== 6}>
              {busy ? 'Checking…' : 'Turn on'}
            </button>
          </form>
        )}
        {!verified.length && (
          <p className="text-xs text-neutral-500">Lost your authenticator? Ask another admin — they follow the recovery steps in the admin procedures.</p>
        )}
      </section>
    </div>
  )
}
