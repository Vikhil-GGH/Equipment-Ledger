/**
 * Supabase/Postgrest errors aren't always plain Error instances by the time
 * they reach a catch block (network failures, thrown plain objects, etc.),
 * so a naive `err instanceof Error` check silently drops the real message.
 */
export function getErrorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return fallback
}
