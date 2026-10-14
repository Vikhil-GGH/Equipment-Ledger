import { useEffect } from 'react'
import { supabaseConfig } from '../lib/supabase'

/**
 * Always-visible marker while running `npm run dev:staging`, so the
 * staging app can never be mistaken for production. Renders nothing in
 * any other mode.
 */
export function StagingBanner() {
  const { isStaging, projectRef } = supabaseConfig

  useEffect(() => {
    if (isStaging && !document.title.startsWith('[STAGING]')) {
      document.title = `[STAGING] ${document.title}`
    }
  }, [isStaging])

  if (!isStaging) return null
  return (
    <div
      role="status"
      className="sticky top-0 z-50 bg-amber-400 px-4 py-1.5 text-center text-xs font-semibold text-amber-950"
    >
      STAGING — synthetic test data only · project {projectRef}
    </div>
  )
}
