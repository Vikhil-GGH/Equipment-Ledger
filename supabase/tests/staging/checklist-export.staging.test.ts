// @vitest-environment node
/**
 * READ-ONLY check of the Onboarding / Offboarding Excel exports against the
 * real staging data (npm run staging:verify): the export reads every
 * record, and its totals and statuses match independent counts from the
 * tables. Nothing is written to the database. With EXPORT_SAMPLE_DIR set,
 * the two workbooks are also saved there (local files only).
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PagedSource } from '../../../src/lib/fetchAllRows'
import {
  buildOffboardingWorkbook,
  buildOnboardingWorkbook,
  exportFilename,
  loadExportData,
  workbookBytes,
  type ListView,
} from '../../../src/features/checklistExport/checklistExport'
import { onboardingProgress } from '../../../src/features/onboarding/onboardingProgress'
import { offboardingProgress } from '../../../src/features/offboarding/offboardingProgress'
import type { OnboardingRow } from '../../../src/features/onboarding/api'
import type { OffboardingRow } from '../../../src/features/offboarding/api'
import { signInReader } from './reader'
// @ts-expect-error — plain .mjs helper shared with the other staging scripts
import { loadStagingEnv } from '../../../scripts/staging/lib.mjs'

// The export modules import the app's Supabase client; never create it here
// (it would read the app's own .env). This test passes its own staging client.
vi.mock('../../../src/lib/supabase', () => ({ supabase: {} }))

const env = loadStagingEnv(['STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD']) as Record<string, string>
const VIEW: ListView = { search: '', statusFilter: 'all', sort: { key: 'started', direction: 'desc' } }
let c: SupabaseClient


beforeAll(async () => {
  ;({ c } = await signInReader(env)) // a synthetic viewer once 031 is applied (reader.ts)
}, 60_000)
afterAll(async () => {
  await c?.auth.signOut()
})

const count = async (table: string, f?: (q: any) => any) => {
  let q = c.from(table).select('*', { count: 'exact', head: true })
  if (f) q = f(q)
  const { count: n, error } = await q
  if (error) throw error
  return n ?? 0
}
const rows = (wb: XLSX.WorkBook, sheet: string) => XLSX.utils.sheet_to_json<Record<string, any>>(wb.Sheets[sheet], { defval: '' })
const save = (name: string, wb: XLSX.WorkBook) => {
  if (process.env.EXPORT_SAMPLE_DIR) writeFileSync(join(process.env.EXPORT_SAMPLE_DIR, name), workbookBytes(XLSX, wb))
}

describe('checklist Excel exports match the staging records (read-only)', () => {
  it('Onboarding: every record, statuses and equipment counts', async () => {
    const data = await loadExportData<OnboardingRow>(c as unknown as PagedSource, 'onboarding_checklists', VIEW, onboardingProgress)
    const { wb } = buildOnboardingWorkbook(XLSX, data, VIEW, new Date())
    const read = XLSX.read(workbookBytes(XLSX, wb), { type: 'array' })
    const summary = rows(read, 'Onboarding Summary')
    expect(summary).toHaveLength(await count('onboarding_checklists'))
    for (const r of data.records) {
      const row = summary.find((s) => s['Employee Name'] === r.employee_name && s['Steps Completed'] === `${onboardingProgress(r).done}/4`)
      expect(row, r.employee_name).toBeTruthy()
      if (!r.employee_id) continue
      const open = await count('equipment_issues', (q) => q.eq('employee_id', r.employee_id).eq('status', 'open').in('asset_collection', ['serialized_assets', 'active_laptops_np']))
      expect(summary.filter((s) => s['Employee Name'] === r.employee_name).some((s) => s['Laptops Assigned Now'] === open), r.employee_name).toBe(true)
    }
    const employeeIds = [...new Set(data.records.map((r) => r.employee_id).filter(Boolean))] as string[]
    const issues = employeeIds.length ? await count('equipment_issues', (q) => q.in('employee_id', employeeIds)) : 0
    expect(rows(read, 'Issued Equipment')).toHaveLength(issues)
    save(exportFilename('Onboarding', new Date()), wb)
  })

  it('Offboarding: every record, return outcomes and pending counts', async () => {
    const data = await loadExportData<OffboardingRow>(c as unknown as PagedSource, 'offboarding_checklists', VIEW, offboardingProgress)
    const { wb } = buildOffboardingWorkbook(XLSX, data, VIEW, new Date())
    const read = XLSX.read(workbookBytes(XLSX, wb), { type: 'array' })
    const summary = rows(read, 'Offboarding Summary')
    expect(summary).toHaveLength(await count('offboarding_checklists'))
    let pendingTotal = 0
    for (const r of data.records.filter((x) => x.employee_id)) {
      const pending = await count('equipment_issues', (q) => q.eq('employee_id', r.employee_id).eq('status', 'open'))
      const items = await count('equipment_issues', (q) => q.eq('employee_id', r.employee_id).not('status', 'in', '(transferred,unassigned)'))
      const row = summary.find((s) => s['Employee Name'] === r.employee_name && s['Pending Return'] === pending && s['Equipment Items'] === items)
      expect(row, r.employee_name).toBeTruthy()
      pendingTotal += pending
    }
    const returns = rows(read, 'Equipment Returns')
    expect(returns.filter((x) => x.Pending === 'Yes').length).toBeLessThanOrEqual(pendingTotal)
    for (const x of returns) expect(['Yes', 'No']).toContain(x.Pending)
    // Equipment History: every closed register entry of these employees, labelled historical.
    const ids = [...new Set(data.records.map((r) => r.employee_id).filter(Boolean))] as string[]
    const closed = ids.length ? await count('equipment_issues', (q) => q.in('employee_id', ids).neq('status', 'open')) : 0
    const history = rows(read, 'Equipment History')
    expect(history).toHaveLength(closed)
    for (const h of history) expect(h['Record Type']).toBe('Historical record')
    save(exportFilename('Offboarding', new Date()), wb)
  })
})
