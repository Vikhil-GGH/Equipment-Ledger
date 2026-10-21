import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAssetsList } from '../features/assets/api'
import { useBulkItemsList } from '../features/bulk/api'
import { useOnboardingList } from '../features/onboarding/api'
import { useOffboardingList } from '../features/offboarding/api'
import { useExistingBulkItemKeys } from '../features/import/api'

// Screen lists must show EVERY row. The real API returns at most 1,000 rows per request, so this fake does too:
// any list that reads with a plain select would silently stop at 1,000 and fail these tests.
const TABLES: Record<string, Record<string, unknown>[]> = vi.hoisted(() => ({}))
const pad = (i: number) => String(i).padStart(6, '0')
TABLES.monitors = Array.from({ length: 2300 }, (_, i) => ({ id: `m-${pad(i)}`, name: `Monitor ${i}`, serial: `MON-${i}`, assigned_to: null, updated_at: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z` }))
TABLES.bulk_items = Array.from({ length: 1200 }, (_, i) => ({ id: `b-${pad(i)}`, name: `Item ${String(1199 - i).padStart(4, '0')}`, category: i % 2 ? 'Cable' : 'Mouse' }))
TABLES.onboarding_checklists = Array.from({ length: 1100 }, (_, i) => ({ id: `o-${pad(i)}`, employee_name: `Hire ${i}`, created_at: `2026-02-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z` }))
TABLES.offboarding_checklists = Array.from({ length: 1100 }, (_, i) => ({ id: `f-${pad(i)}`, employee_name: `Leaver ${i}`, created_at: `2026-03-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z` }))

vi.mock('../lib/supabase', () => {
  const query = (table: string) => {
    let rows = TABLES[table] ?? []
    const q: Record<string, unknown> = {
      select: () => q,
      or: () => q,
      ilike: (col: string, pattern: string) => {
        const needle = pattern.replace(/^%|%$/g, '').toLowerCase()
        rows = rows.filter((r) => String(r[col] ?? '').toLowerCase().includes(needle))
        return q
      },
      order: () => q,
      range: (from: number, to: number) => {
        const sorted = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))
        return Promise.resolve({ data: sorted.slice(from, Math.min(to + 1, from + 1000)), count: rows.length, error: null })
      },
    }
    return q
  }
  return { supabase: { from: (t: string) => query(t) } }
})

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('screen lists read every row, not just the first 1,000', () => {
  it('Monitors / Other Equipment list: all 2,300 rows, newest change first, none twice', async () => {
    const { result } = renderHook(() => useAssetsList('monitors'), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    const rows = result.current.data!
    expect(rows).toHaveLength(2300)
    expect(new Set(rows.map((r) => r.id)).size).toBe(2300)
    expect(rows.every((r, i) => i === 0 || rows[i - 1].updated_at >= r.updated_at)).toBe(true)
  })

  it('Bulk Stock list: all 1,200 items, sorted by name', async () => {
    const { result } = renderHook(() => useBulkItemsList(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    const rows = result.current.data!
    expect(rows).toHaveLength(1200)
    expect(rows[0].name).toBe('Item 0000')
    expect(rows.at(-1)!.name).toBe('Item 1199')
  })

  it('Onboarding and Offboarding lists: all 1,100 records each, newest first; a search is counted over matching rows', async () => {
    const on = renderHook(() => useOnboardingList(), { wrapper })
    const off = renderHook(() => useOffboardingList(), { wrapper })
    await waitFor(() => expect(on.result.current.data && off.result.current.data).toBeTruthy())
    expect(on.result.current.data).toHaveLength(1100)
    expect(off.result.current.data).toHaveLength(1100)
    const d = off.result.current.data!
    expect(d.every((r, i) => i === 0 || d[i - 1].created_at >= r.created_at)).toBe(true)
    const found = renderHook(() => useOffboardingList('leaver 10'), { wrapper })
    await waitFor(() => expect(found.result.current.data).toBeDefined())
    expect(found.result.current.data!.every((r) => r.employee_name.toLowerCase().includes('leaver 10'))).toBe(true)
    expect(found.result.current.data!.length).toBe(TABLES.offboarding_checklists.filter((r) => String(r.employee_name).toLowerCase().includes('leaver 10')).length)
  })

  it('Excel import preview knows ALL existing Bulk Stock items (1,200), so none is mislabelled "new"', async () => {
    const { result } = renderHook(() => useExistingBulkItemKeys(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data!.size).toBe(1200)
    expect(result.current.data!.has('item 1199|||mouse') || result.current.data!.has('item 1199|||cable')).toBe(true)
  })
})
