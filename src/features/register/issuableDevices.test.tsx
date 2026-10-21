import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useIssuableDevices } from './api'

// A tiny in-memory stand-in for the two laptop tables and Other Equipment.
// It applies the .eq / .in / .or filters the hook sends, so the test checks
// what the picker would actually be offered.
const STATUSES = ['available', 'retained', 'decommissioned', 'damaged', 'provided', 'nonfunctional', 'lost'] as const
const TABLES: Record<string, { id: string; name: string; category: string; serial: string; status: string; location: string | null }[]> = {
  serialized_assets: STATUSES.map((s) => ({ id: `inv-${s}`, name: 'Dell Latitude', category: 'Laptop', serial: `INV-${s}`, status: s, location: null })),
  active_laptops_np: STATUSES.map((s) => ({ id: `np-${s}`, name: 'ThinkPad', category: 'Laptop', serial: `NP-${s}`, status: s, location: null })),
  other_equipment: STATUSES.map((s) => ({ id: `oth-${s}`, name: 'Headset', category: 'Headset', serial: `HS-${s}`, status: s, location: null })),
}

vi.mock('../../lib/supabase', () => {
  const query = (table: string) => {
    let rows = TABLES[table] ?? []
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, v: string) => ((rows = rows.filter((r) => (r as Record<string, unknown>)[col] === v)), q),
      in: (col: string, vs: string[]) => ((rows = rows.filter((r) => vs.includes((r as Record<string, string>)[col]))), q),
      or: () => q, // the headset name/category filter: every Other Equipment row here is a headset
      order: () => Promise.resolve({ data: [...rows].sort((a, b) => a.serial.localeCompare(b.serial)), error: null }),
    }
    return q
  }
  return { supabase: { from: (t: string) => query(t) } }
})

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('the available-device picker', () => {
  it('offers only Available laptops: never retained, decommissioned, damaged, provided or otherwise unavailable ones', async () => {
    const { result } = renderHook(() => useIssuableDevices('laptop'), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data!.map((d) => d.serial).sort()).toEqual(['INV-available', 'NP-available'])
    expect(result.current.data!.every((d) => d.status === 'available')).toBe(true)
    expect(result.current.data!.map((d) => d.collection).sort()).toEqual(['active_laptops_np', 'serialized_assets'])
  })

  it('offers only Available headsets too', async () => {
    const { result } = renderHook(() => useIssuableDevices('headset'), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data!.map((d) => d.serial)).toEqual(['HS-available'])
  })
})
