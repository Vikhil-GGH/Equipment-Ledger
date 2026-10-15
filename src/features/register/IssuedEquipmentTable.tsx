import type { ReactNode } from 'react'
import { ISSUE_STATUS_LABELS, itemTypeLabel, type EquipmentIssue } from './registerModel'

const STATUS_TONE: Record<EquipmentIssue['status'], string> = {
  open: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:ring-amber-800',
  returned: 'bg-green-50 text-green-800 ring-green-200 dark:bg-green-900/30 dark:text-green-300 dark:ring-green-800',
  returned_damaged: 'bg-orange-50 text-orange-800 ring-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:ring-orange-800',
  decommissioned: 'bg-neutral-100 text-neutral-700 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700',
  retained_authorized: 'bg-indigo-50 text-indigo-800 ring-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:ring-indigo-800',
  lost: 'bg-rose-100 text-rose-900 ring-rose-200 dark:bg-rose-900/40 dark:text-rose-200 dark:ring-rose-800',
  transferred: 'bg-neutral-100 text-neutral-600 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:ring-neutral-700',
  unassigned: 'bg-neutral-100 text-neutral-600 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:ring-neutral-700',
}

export function IssueStatusBadge({ status }: { status: EquipmentIssue['status'] }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_TONE[status]}`}>
      {ISSUE_STATUS_LABELS[status]}
    </span>
  )
}

/** Employee's equipment: type, description, serial, quantity, issued date, return status (+ optional action column). */
export function IssuedEquipmentTable({
  issues,
  emptyMessage,
  action,
}: {
  issues: EquipmentIssue[]
  emptyMessage: string
  action?: (issue: EquipmentIssue) => ReactNode
}) {
  if (!issues.length) return <p className="text-sm text-neutral-500">{emptyMessage}</p>
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-neutral-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Type</th>
            <th scope="col" className="px-3 py-2 font-medium">Item</th>
            <th scope="col" className="hidden px-3 py-2 font-medium sm:table-cell">Serial</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Qty</th>
            <th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">Issued</th>
            <th scope="col" className="px-3 py-2 font-medium">Return status</th>
            {action && <th scope="col" className="px-3 py-2 font-medium">Inventory action</th>}
          </tr>
        </thead>
        <tbody>
          {issues.map((i) => (
            <tr key={i.id} className="border-t border-stone-100 align-top dark:border-neutral-800">
              <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{itemTypeLabel(i)}</td>
              <td className="px-3 py-2 text-neutral-900 dark:text-neutral-100">
                {i.description}
                <span className="block font-mono text-xs text-neutral-500 sm:hidden">{i.serial}</span>
              </td>
              <td className="hidden px-3 py-2 font-mono text-xs text-neutral-600 sm:table-cell dark:text-neutral-400">{i.serial ?? '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{i.quantity}</td>
              <td className="hidden px-3 py-2 tabular-nums text-neutral-600 md:table-cell dark:text-neutral-400">
                {new Date(i.issued_at).toLocaleDateString()}
                {i.source === 'backfill' && <span className="block text-xs text-neutral-400">recorded from existing data</span>}
              </td>
              <td className="px-3 py-2">
                <IssueStatusBadge status={i.status} />
                {i.closed_at && <span className="mt-0.5 block text-xs text-neutral-500">{new Date(i.closed_at).toLocaleDateString()}</span>}
                {i.close_note && <span className="mt-0.5 block text-xs text-neutral-500">{i.close_note}</span>}
              </td>
              {action && <td className="px-3 py-2">{action(i)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
