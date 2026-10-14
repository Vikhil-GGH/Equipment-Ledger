import { useEffect, useState, type FormEvent } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './useAuth'
import { sendResetCode, setNewPassword, verifyResetCode } from './passwordReset'

type Mode = 'login' | 'request' | 'reset'

const MIN_PASSWORD_LENGTH = 6

const inputClass =
  'w-full rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-teal-500 focus:bg-white focus:ring-2 focus:ring-teal-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100'
const labelClass = 'mb-1 block text-sm font-medium text-stone-700 dark:text-neutral-300'
const linkButtonClass =
  'text-sm font-medium text-teal-600 transition hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300'
const primaryButtonClass =
  'w-full rounded-lg bg-teal-600 px-3 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-50 dark:bg-teal-600 dark:hover:bg-teal-500'

export function LoginPage() {
  const { session, isPasswordRecovery, clearPasswordRecovery, signIn, signOut } = useAuth()
  const location = useLocation()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [newPassword, setNewPasswordValue] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  // Verifying the code consumes it, so if the password update then fails we
  // must retry only the update, not the verification.
  const [codeVerified, setCodeVerified] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Supabase still emails a clickable reset link unless the "Reset Password"
  // template in the dashboard is switched to {{ .Token }} (see README). If
  // someone clicks that link instead of using our code form, Supabase
  // authenticates them straight away and fires this same PASSWORD_RECOVERY
  // event — so treat it exactly like a verified code: skip to the "choose a
  // new password" step instead of leaving mode at 'login'/'request', which
  // is what used to let a clicked link drop them into the app unprompted.
  useEffect(() => {
    if (isPasswordRecovery && mode !== 'reset') {
      setCodeVerified(true)
      setCode('')
      setNotice('Choose a new password to finish resetting it.')
      setMode('reset')
    }
    // Only react to the recovery flag flipping on; `mode` is intentionally
    // excluded so this doesn't re-fire every time the user changes mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPasswordRecovery])

  // Verifying the code signs the user in; hold off redirecting until the new
  // password has actually been saved.
  if (session && mode !== 'reset') {
    const from = (location.state as { from?: Location })?.from
    return <Navigate to={from?.pathname ?? '/'} replace />
  }

  function goTo(next: Mode) {
    setMode(next)
    setError(null)
    setNotice(null)
  }

  // Abandoning the reset after the code was verified would otherwise leave the
  // user signed in on the recovery session without having set a password.
  async function abandonReset(next: Mode) {
    if (codeVerified) {
      await signOut()
      setCodeVerified(false)
    }
    clearPasswordRecovery()
    goTo(next)
  }

  async function handleSignIn(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error } = await signIn(email, password)
    setSubmitting(false)
    if (error) setError(error)
  }

  async function handleSendCode(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error } = await sendResetCode(email)
    setSubmitting(false)
    if (error) {
      setError(error)
      return
    }
    setCode('')
    setCodeVerified(false)
    setMode('reset')
    setNotice(`If an account exists for ${email}, we've sent it a code.`)
  }

  async function handleReset(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    if (!codeVerified) {
      const { error } = await verifyResetCode(email, code)
      if (error) {
        setSubmitting(false)
        setError(error)
        return
      }
      setCodeVerified(true)
    }
    const { error } = await setNewPassword(newPassword)
    setSubmitting(false)
    if (error) {
      setError(error)
      return
    }
    // Clear the recovery flag before leaving reset mode — otherwise the
    // effect above would see mode !== 'reset' and immediately flip straight
    // back into it. With it cleared, the recovery session is already active,
    // so this lets App render the normal routes and land the user in the app.
    clearPasswordRecovery()
    setPassword('')
    setNewPasswordValue('')
    setConfirmPassword('')
    goTo('login')
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-amber-50 via-orange-50/60 to-white px-4 dark:bg-neutral-950 dark:bg-none">
      <div className="w-full max-w-sm rounded-2xl border border-stone-100 bg-white p-8 shadow-xl shadow-stone-200/50 dark:border-neutral-800 dark:bg-neutral-900 dark:shadow-none">
        <div className="mb-1 flex items-center justify-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-teal-500 text-teal-600 dark:border-teal-400 dark:text-teal-400">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
              <path
                d="M12 3a9 9 0 1 0 9 9"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <path
                d="M12 8a4 4 0 1 0 4 4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span className="text-sm font-bold uppercase tracking-tight text-teal-700 dark:text-teal-400">
            GroundGame Health
          </span>
        </div>
        <h1 className="mb-1 text-center text-xl font-bold text-neutral-900 dark:text-neutral-100">
          Equipment Ledger
        </h1>
        <p className="mb-6 text-center text-sm text-neutral-500">
          Asset tracking for GroundGame Health
        </p>

        {mode === 'login' && (
          <form onSubmit={handleSignIn} className="space-y-4">
            <div>
              <label htmlFor="email" className={labelClass}>
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="password" className={labelClass}>
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputClass}
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className={primaryButtonClass}
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>

            <div className="text-center">
              <button type="button" onClick={() => goTo('request')} className={linkButtonClass}>
                Forgot password?
              </button>
            </div>
          </form>
        )}

        {mode === 'request' && (
          <form onSubmit={handleSendCode} className="space-y-4">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Enter your email and we'll send you a code to reset your password.
            </p>
            <div>
              <label htmlFor="reset-email" className={labelClass}>
                Email
              </label>
              <input
                id="reset-email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className={primaryButtonClass}
            >
              {submitting ? 'Sending…' : 'Send code'}
            </button>

            <div className="text-center">
              <button type="button" onClick={() => goTo('login')} className={linkButtonClass}>
                Back to sign in
              </button>
            </div>
          </form>
        )}

        {mode === 'reset' && (
          <form onSubmit={handleReset} className="space-y-4">
            {notice && (
              <p role="status" className="text-sm text-neutral-600 dark:text-neutral-400">
                {notice}
              </p>
            )}
            {!codeVerified && (
              <div>
                <label htmlFor="reset-code" className={labelClass}>
                  Code
                </label>
                <input
                  id="reset-code"
                  type="text"
                  inputMode="numeric"
                  required
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className={inputClass}
                />
              </div>
            )}
            <div>
              <label htmlFor="new-password" className={labelClass}>
                New password
              </label>
              <input
                id="new-password"
                type="password"
                required
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPasswordValue(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="confirm-password" className={labelClass}>
                Confirm new password
              </label>
              <input
                id="confirm-password"
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={inputClass}
              />
            </div>

            {error && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className={primaryButtonClass}
            >
              {submitting ? 'Updating…' : 'Update password'}
            </button>

            <div className="flex justify-between">
              <button type="button" onClick={() => abandonReset('request')} className={linkButtonClass}>
                Resend code
              </button>
              <button type="button" onClick={() => abandonReset('login')} className={linkButtonClass}>
                Back to sign in
              </button>
            </div>
          </form>
        )}

        {mode === 'login' && (
          <p className="mt-6 text-xs text-neutral-400">
            Accounts are created by an admin. Contact yours if you need access.
          </p>
        )}
      </div>
    </div>
  )
}
