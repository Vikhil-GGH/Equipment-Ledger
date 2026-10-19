import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { getErrorMessage } from '../../lib/errors'
import type { PagedSource } from '../../lib/fetchAllRows'
import { saveFile } from '../../lib/xlsxWorkbook'
import { onboardingProgress } from '../onboarding/onboardingProgress'
import { offboardingProgress } from '../offboarding/offboardingProgress'
import type { OnboardingRow } from '../onboarding/api'
import type { OffboardingRow } from '../offboarding/api'
import {
  buildOffboardingWorkbook,
  buildOnboardingWorkbook,
  exportFilename,
  loadExportData,
  workbookBytes,
  type ListView,
} from './checklistExport'

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />
    </svg>
  )
}

/**
 * Downloads the list as Excel: every record matching the current search,
 * status filter and sort (not just what's on screen), read-only.
 */
export function DownloadExcelButton({ kind, view }: { kind: 'Onboarding' | 'Offboarding'; view: ListView }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function download() {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const client = supabase as unknown as PagedSource
      const XLSX = await import('xlsx')
      const now = new Date()
      const built =
        kind === 'Onboarding'
          ? buildOnboardingWorkbook(XLSX, await loadExportData<OnboardingRow>(client, 'onboarding_checklists', view, onboardingProgress), view, now)
          : buildOffboardingWorkbook(XLSX, await loadExportData<OffboardingRow>(client, 'offboarding_checklists', view, offboardingProgress), view, now)
      saveFile(exportFilename(kind, now), workbookBytes(XLSX, built.wb))
      setDone(`Downloaded ${built.records} record${built.records === 1 ? '' : 's'}, ${built.items} equipment row${built.items === 1 ? '' : 's'}.`)
    } catch (err) {
      console.error(`${kind} export failed:`, err)
      setError(getErrorMessage(err, 'Download failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-stretch sm:items-end">
      <button
        type="button"
        className="btn-secondary inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
        onClick={() => void download()}
        disabled={busy}
        aria-busy={busy || undefined}
      >
        <DownloadIcon />
        {busy ? 'Preparing…' : 'Download Excel'}
      </button>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="mt-1 text-xs text-neutral-500">
          {done}
        </p>
      )}
    </div>
  )
}
