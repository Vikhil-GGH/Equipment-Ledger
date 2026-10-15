import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { combineLaptops, type LaptopRecord, type LaptopSource } from './laptopInventory'

// PostgREST returns at most `max_rows` (1000 by default) per request, so a
// plain select('*') silently stops there. Page through with range() until
// a short page, so the inventory — and its export — is always complete.
const PAGE = 1000

async function fetchAll(table: LaptopSource): Promise<LaptopRecord[]> {
  const rows: LaptopRecord[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    rows.push(...(data as LaptopRecord[]))
    if (data.length < PAGE) return rows
  }
}

/**
 * Both laptop tables, combined. Each half is cached under the same
 * ['assets', <table>, 'list', …] key family the lifecycle, swap, import and
 * onboarding mutations already invalidate, so the combined list refreshes
 * itself whenever a laptop is assigned, collected, moved or edited.
 */
export function useLaptopInventory() {
  const inventory = useQuery({
    queryKey: ['assets', 'serialized_assets', 'list', 'laptop-inventory'],
    queryFn: () => fetchAll('serialized_assets'),
  })
  const activeNp = useQuery({
    queryKey: ['assets', 'active_laptops_np', 'list', 'laptop-inventory'],
    queryFn: () => fetchAll('active_laptops_np'),
  })
  const rows = useMemo(
    () => (inventory.data && activeNp.data ? combineLaptops(inventory.data, activeNp.data) : undefined),
    [inventory.data, activeNp.data],
  )
  return {
    rows,
    isLoading: inventory.isLoading || activeNp.isLoading,
    error: inventory.error ?? activeNp.error,
  }
}
