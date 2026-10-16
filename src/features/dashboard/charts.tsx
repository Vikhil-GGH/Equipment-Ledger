import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { Breakdown, Segment } from './dashboardModel'
import { GROUP_CLASSES, GROUP_LABELS, type StatusGroup } from './statusColors'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function detailText(b: Breakdown, group: StatusGroup) {
  const d = b.detail[group]
  return d.length > 1 || (group === 'other' && d.length) ? d.map((x) => `${x.label} ${x.count}`).join(', ') : ''
}

/**
 * Donut of a breakdown. Each segment is a link (keyboard: Tab + Enter);
 * hovering or focusing one shows its numbers in the centre, and the legend
 * beside it lists every segment as a normal link with count and percent.
 */
export function DonutChart({
  data,
  unit,
  hrefFor,
  label,
}: {
  data: Breakdown
  unit: string
  hrefFor?: (group: StatusGroup) => string
  label: string
}) {
  const navigate = useNavigate()
  const [focus, setFocus] = useState<Segment | null>(null)
  const visible = data.segments.filter((s) => s.count > 0)
  const shares = visible.map((s) => (s.count / data.total) * 100)
  const offsets = shares.map((_, i) => shares.slice(0, i).reduce((a, b) => a + b, 0))
  const R = 15.915 // circumference 100, so dash lengths are percentages
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row lg:flex-col">
      <div className="relative h-40 w-40 shrink-0">
        <svg viewBox="0 0 42 42" className="h-full w-full -rotate-90" role="group" aria-label={label}>
          <circle cx="21" cy="21" r={R} fill="none" strokeWidth="6" className="stroke-neutral-100 dark:stroke-neutral-800" />
          {visible.map((s, i) => {
            const share = shares[i]
            const dash = `${Math.max(share - (visible.length > 1 ? 0.8 : 0), 0.01)} ${100 - share + (visible.length > 1 ? 0.8 : 0)}`
            const seg = (
              <circle
                key={s.group}
                cx="21"
                cy="21"
                r={R}
                fill="none"
                strokeWidth={focus?.group === s.group ? 7.5 : 6}
                strokeDasharray={dash}
                strokeDashoffset={-offsets[i]}
                className={`${GROUP_CLASSES[s.group].stroke} cursor-pointer outline-none transition-[stroke-width] focus-visible:stroke-[8]`}
                role={hrefFor ? 'link' : 'img'}
                tabIndex={hrefFor ? 0 : -1}
                aria-label={`${GROUP_LABELS[s.group]}: ${s.count} (${s.pct}%)`}
                onMouseEnter={() => setFocus(s)}
                onMouseLeave={() => setFocus(null)}
                onFocus={() => setFocus(s)}
                onBlur={() => setFocus(null)}
                onClick={() => hrefFor && navigate(hrefFor(s.group))}
                onKeyDown={(e) => {
                  if (hrefFor && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    navigate(hrefFor(s.group))
                  }
                }}
              >
                <title>{`${GROUP_LABELS[s.group]}: ${s.count} of ${data.total} (${s.pct}%)`}</title>
              </circle>
            )
            return seg
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center" aria-live="polite">
          <span className="text-3xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">{focus ? focus.count : data.total}</span>
          <span className="max-w-24 text-[11px] leading-tight text-neutral-500">
            {focus ? `${GROUP_LABELS[focus.group]} · ${focus.pct}%` : unit}
          </span>
        </div>
      </div>
      <Legend data={data} hrefFor={hrefFor} />
    </div>
  )
}

export function Legend({ data, hrefFor }: { data: Breakdown; hrefFor?: (g: StatusGroup) => string }) {
  return (
    <ul className="w-full space-y-1 text-sm">
      {data.segments.map((s) => {
        const extra = detailText(data, s.group)
        const body = (
          <>
            <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${GROUP_CLASSES[s.group].bg}`} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="whitespace-nowrap text-neutral-700 dark:text-neutral-300">{GROUP_LABELS[s.group]}</span>
              {extra && <span className="block text-xs text-neutral-500">{extra}</span>}
            </span>
            <span className="font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">{s.count}</span>
            <span className="w-10 text-right text-xs tabular-nums text-neutral-500">{s.pct}%</span>
          </>
        )
        return (
          <li key={s.group}>
            {hrefFor ? (
              <Link to={hrefFor(s.group)} className="flex items-start gap-2 rounded-md px-2 py-1 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-teal-600 dark:hover:bg-neutral-800">
                {body}
              </Link>
            ) : (
              <div className="flex items-start gap-2 px-2 py-1">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** One horizontal 100% bar per row; each segment is a link with a tooltip. */
export function StackedBar({ data, to, label }: { data: Breakdown; to?: (g: StatusGroup) => string; label: string }) {
  if (data.total === 0) return <div className="h-3 rounded-full bg-neutral-100 dark:bg-neutral-800" aria-label={`${label}: none`} role="img" />
  return (
    <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" role="group" aria-label={label}>
      {data.segments
        .filter((s) => s.count > 0)
        .map((s) => {
          const tip = `${GROUP_LABELS[s.group]}: ${s.count} (${s.pct}%)${detailText(data, s.group) ? ` — ${detailText(data, s.group)}` : ''}`
          const cls = `${GROUP_CLASSES[s.group].bg} block h-full transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-neutral-900 dark:focus-visible:outline-white`
          const style = { width: `${(s.count / data.total) * 100}%`, minWidth: 6 }
          return to ? (
            <Link key={s.group} to={to(s.group)} className={cls} style={style} title={tip} aria-label={`${label} — ${tip}`} />
          ) : (
            <span key={s.group} className={cls} style={style} title={tip} role="img" aria-label={`${label} — ${tip}`} />
          )
        })}
    </div>
  )
}

export interface ComparisonRow {
  key: string
  label: string
  /** "devices" for serialized equipment, "units" for bulk quantities. */
  unit: 'devices' | 'units'
  data: Breakdown
  to?: (g: StatusGroup) => string
}

export function EquipmentComparison({ rows }: { rows: ComparisonRow[] }) {
  return (
    <div className="space-y-4">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400" aria-label="Legend">
        {(['active', 'available', 'damaged', 'other'] as StatusGroup[]).map((g) => (
          <li key={g} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm ${GROUP_CLASSES[g].bg}`} aria-hidden />
            {GROUP_LABELS[g]}
          </li>
        ))}
      </ul>
      {rows.map((r, i) => (
        <div key={r.key} className={r.unit === 'units' && i > 0 ? 'border-t border-dashed border-neutral-200 pt-4 dark:border-neutral-700' : ''}>
          <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
            <span className="font-medium text-neutral-800 dark:text-neutral-200">{r.label}</span>
            <span className="text-xs tabular-nums text-neutral-500">
              {r.unit === 'units' ? plural(r.data.total, 'unit') + ' (bulk quantity)' : plural(r.data.total, 'device')}
            </span>
          </div>
          <StackedBar data={r.data} to={r.to} label={r.label} />
          <p className="mt-1 text-xs tabular-nums text-neutral-500">
            {r.data.segments.filter((s) => s.count > 0).map((s) => `${GROUP_LABELS[s.group]} ${s.count}`).join(' · ') || 'None recorded'}
          </p>
        </div>
      ))}
    </div>
  )
}
