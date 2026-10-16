import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { fetchAllRows, type PagedSource } from '../../lib/fetchAllRows'
import { useAuth } from '../auth/useAuth'
import { useAssetStats } from '../assets/api'
import { useBulkItemsList, useBulkStockStats } from '../bulk/api'
import { useLaptopInventory } from '../laptops/api'
import { useOffboardingList } from '../offboarding/api'
import { useRegisterAvailable } from '../register/api'
import { useSerialDuplicates } from '../admin/api'
import {
  attentionItems,
  bulkBreakdown,
  kpis,
  laptopBreakdown,
  laptopOwnership,
  statusBreakdown,
  type BulkTotals,
} from './dashboardModel'

/**
 * Open register rows (employee register, 20260901000026). Read page by
 * page so a register over 1,000 rows is still counted in full.
 */
function useOpenIssues(enabled: boolean) {
  return useQuery({
    queryKey: ['register', 'open-issues', 'dashboard'],
    enabled,
    queryFn: async () => {
      const { rows } = await fetchAllRows<{ id: string; employee_id: string | null; status: string }>(
        supabase as unknown as PagedSource,
        'equipment_issues',
        { columns: 'id, employee_id, status' },
      )
      return rows.filter((r) => r.status === 'open')
    },
  })
}

const NO_BULK: BulkTotals = { available: 0, provided: 0, retained: 0, damaged: 0, decommissioned: 0 }

/**
 * Every source the Overview reads, through the same hooks (and cache keys)
 * as the inventory pages — so lifecycle actions, imports and returns
 * refresh the Overview too. Each section reports its own loading/error.
 */
export function useDashboardData() {
  const { role } = useAuth()
  const laptops = useLaptopInventory()
  const monitors = useAssetStats('monitors')
  const other = useAssetStats('other_equipment')
  const bulkTotals = useBulkStockStats()
  const bulkItems = useBulkItemsList()
  const offboarding = useOffboardingList()
  const register = useRegisterAvailable()
  const openIssues = useOpenIssues(!!register.data)
  const duplicates = useSerialDuplicates()

  const model = useMemo(() => {
    const laptopRows = laptops.rows ?? []
    const l = laptopBreakdown(laptopRows)
    const m = statusBreakdown(monitors.data ?? [])
    const o = statusBreakdown(other.data ?? [])
    const b = bulkBreakdown(bulkTotals.data ?? NO_BULK)
    const offboardedEmployees = new Set((offboarding.data ?? []).map((r) => r.employee_id).filter(Boolean))
    const pendingReturns = register.data && openIssues.data
      ? openIssues.data.filter((i) => i.employee_id && offboardedEmployees.has(i.employee_id)).length
      : null
    return {
      laptops: l,
      monitors: m,
      other: o,
      bulk: b,
      ownership: laptopOwnership(laptopRows),
      kpis: kpis(l, m, o, b, bulkItems.data?.length ?? 0),
      attention: attentionItems({
        laptops: l,
        laptopRows,
        monitors: m,
        other: o,
        bulk: b,
        bulkItems: bulkItems.data ?? [],
        pendingReturns,
        offboardingNeedsReview: (offboarding.data ?? []).filter((r) => r.outcome_needs_review).length,
        duplicateSerials: duplicates.data ? duplicates.data.length : null,
        isAdmin: role === 'admin',
      }),
    }
  }, [laptops.rows, monitors.data, other.data, bulkTotals.data, bulkItems.data, offboarding.data, register.data, openIssues.data, duplicates.data, role])

  const status = (q: { isLoading: boolean; error: unknown }) => ({ loading: q.isLoading, error: q.error ? (q.error as Error) : null })
  return {
    model,
    sections: {
      laptops: status(laptops),
      monitors: status(monitors),
      other: status(other),
      bulk: { loading: bulkTotals.isLoading || bulkItems.isLoading, error: (bulkTotals.error ?? bulkItems.error) as Error | null },
      attention: {
        loading: laptops.isLoading || monitors.isLoading || other.isLoading || bulkTotals.isLoading || bulkItems.isLoading || offboarding.isLoading || (!!register.data && openIssues.isLoading),
        error: (offboarding.error ?? openIssues.error ?? null) as Error | null,
      },
    },
  }
}
