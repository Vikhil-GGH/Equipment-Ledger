import { supabase } from '../../lib/supabase'

// Code-based password recovery. Supabase's recovery email only contains a
// code (rather than a magic link) if the "Reset Password" email template
// uses {{ .Token }} — see supabase/templates/recovery.html.

export async function sendResetCode(email: string) {
  // Supabase doesn't reveal whether the address has an account, so a success
  // here doesn't confirm one exists.
  const { error } = await supabase.auth.resetPasswordForEmail(email)
  return { error: error?.message ?? null }
}

// Verifying the code signs the user in with a recovery session, which is
// what authorises the follow-up password update.
export async function verifyResetCode(email: string, code: string) {
  const { error } = await supabase.auth.verifyOtp({
    email,
    token: code.trim(),
    type: 'recovery',
  })
  return { error: error?.message ?? null }
}

export async function setNewPassword(password: string) {
  const { error } = await supabase.auth.updateUser({ password })
  return { error: error?.message ?? null }
}
