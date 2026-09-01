import { useMutation } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import type { AssetCollection } from '../../types/database.types'

export interface SerialLookupResult {
  collection: AssetCollection
  id: string
}

/**
 * Looks up a scanned serial across the two serial-tracked collections.
 * Bulk Stock is intentionally excluded — it has no `serial` column (items
 * are tracked by quantity, not individually), so there's nothing to match
 * a scanned code against there.
 */
export function useSerialLookup() {
  return useMutation({
    mutationFn: async (serial: string): Promise<SerialLookupResult | null> => {
      const [serializedAssets, activeLaptopsNp] = await Promise.all([
        supabase.from('serialized_assets').select('id').eq('serial', serial).maybeSingle(),
        supabase.from('active_laptops_np').select('id').eq('serial', serial).maybeSingle(),
      ])
      if (serializedAssets.error) throw serializedAssets.error
      if (activeLaptopsNp.error) throw activeLaptopsNp.error

      if (serializedAssets.data) {
        return { collection: 'serialized_assets', id: serializedAssets.data.id }
      }
      if (activeLaptopsNp.data) {
        return { collection: 'active_laptops_np', id: activeLaptopsNp.data.id }
      }
      return null
    },
  })
}
