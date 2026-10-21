import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useIssuableDevices } from './api'

// An in-memory stand-in for the PostgREST API: it applies .eq / .in / .or / .ilike, reports an exact count,
// honours .range(), and — like the real server — never returns more than 1,000 rows in one request.
const STATUSES = ['available', 'retained', 'decommissioned', 'damaged', 'provided', 'nonfunctional', 'lost'] as const
type Row = { id: string; name: string; category: string; serial: string; status: string; location: string | null }
const mk = (prefix: string, name: string, category: string): Row[] =>
  STATUSES.map((s) => ({ id: `${prefix}-${s}`, name, category, serial: `${prefix.toUpperCase()}-${s}`, status: s, location: null }))

const TABLES: Record<string, Row[]> = vi.hoisted(() => ({}))
TABLES.serialized_assets = mk('inv', 'Dell Latitude', 'Laptop')
TABLES.active_laptops_np = mk('np', 'ThinkPad', 'Laptop')
TABLES.other_equipment = mk('oth', 'Headset', 'Headset')

vi.mock('../../lib/supabase', () => {
  const query = (table: string) => {
    let rows = TABLES[table] ?? []
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, v: string) => ((rows = rows.filter((r) => (r as Record<string, unknown>)[col] === v)), q),
      in: (col: string, vs: string[]) => ((rows = rows.filter((r) => vs.includes((r as Record<string, string>)[col]))), q),
      or: () => q, // the headset name/category filter: every Other Equipment row here is a headset
      order: () => q,
      range: (from: number, to: number) => {
        const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id))
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
    expect(result.current.data!.map((d) => d.serial)).toEqual(['OTH-available'])
  })

  it('lists every Available laptop even when there are more than 1,000 (the server caps one request at 1,000)', async () => {
    const many = (prefix: string, n: number): Row[] =>
      Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${String(i).padStart(5, '0')}`, name: 'Dell', category: 'Laptop', serial: `${prefix.toUpperCase()}-${String(i).padStart(5, '0')}`, status: i % 3 === 0 ? 'retained' : 'available', location: null }))
    TABLES.serialized_assets = many('inv', 2400) // 1,600 Available
    TABLES.active_laptops_np = many('np', 1500) // 1,000 Available
    const { result } = renderHook(() => useIssuableDevices('laptop'), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data).toHaveLength(2600)
    expect(result.current.data!.every((d) => d.status === 'available')).toBe(true)
    expect(new Set(result.current.data!.map((d) => d.id)).size).toBe(2600) // no row twice
  })
})
