import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { getErrorMessage } from '../../lib/errors'
import type { AttentionItem, Breakdown } from './dashboardModel'
import { GROUP_CLASSES, GROUP_LABELS } from './statusColors'
import { AlertIcon, ArrowIcon, CheckIcon } from './icons'

export function Panel({
  title,
  action,
  children,
  className = '',
  loading,
  error,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  className?: string
  loading?: boolean
  error?: Error | null
}) {
  return (
    <section className={`card flex flex-col ${className}`} aria-label={title} aria-busy={loading || undefined}>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
        {action}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {getErrorMessage(error, `Couldn't load ${title.toLowerCase()}`)}
        </p>
      ) : loading ? (
        <div className="space-y-2" aria-label="Loading">
          <div className="h-4 w-2/3 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
          <div className="h-24 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
        </div>
      ) : (
        children
      )}
    </section>
  )
}

export function ViewLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-400">
      {children} <ArrowIcon />
    </Link>
  )
}

export function KpiCard({
  label,
  value,
  secondary,
  icon,
  tone,
  to,
  loading,
}: {
  label: string
  value: number
  secondary: ReactNode
  icon: ReactNode
  tone: string
  to?: string
  loading?: boolean
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
        <span className={`rounded-lg p-2 ${tone}`}>{icon}</span>
      </div>
      {loading ? (
        <div className="mt-2 h-9 w-16 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" aria-label="Loading" />
      ) : (
        <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-neutral-900 dark:text-neutral-100">{value}</p>
      )}
      <p className="mt-1 text-xs text-neutral-500">{loading ? ' ' : secondary}</p>
    </>
  )
  const cls = 'card block transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600'
  return to ? (
    <Link to={to} className={cls} aria-label={`${label}: ${value}. Open`}>
      {body}
    </Link>
  ) : (
    <div className="card">{body}</div>
  )
}

/** A category summary: total, and one progress bar per status group. */
export function SummaryCard({
  title,
  icon,
  data,
  unit,
  to,
  loading,
  error,
  note,
}: {
  title: string
  icon: ReactNode
  data: Breakdown
  unit: 'devices' | 'units'
  to: string
  loading?: boolean
  error?: Error | null
  note?: ReactNode
}) {
  return (
    <Panel
      title={title}
      loading={loading}
      error={error}
      action={<span className="rounded-lg bg-neutral-100 p-1.5 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">{icon}</span>}
    >
      <p className="text-2xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
        {data.total} <span className="text-sm font-normal text-neutral-500">{unit === 'units' ? 'units' : 'devices'}</span>
      </p>
      {note && <p className="text-xs text-neutral-500">{note}</p>}
      {data.total === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">Nothing recorded yet.</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {data.segments.map((s) => (
            <li key={s.group}>
              <div className="mb-1 flex justify-between text-xs">
                <span className={`font-medium ${GROUP_CLASSES[s.group].text}`}>{GROUP_LABELS[s.group]}</span>
                <span className="tabular-nums text-neutral-600 dark:text-neutral-400">
                  {s.count} · {s.pct}%
                </span>
              </div>
              <div
                className="h-1.5 rounded-full bg-neutral-100 dark:bg-neutral-800"
                role="progressbar"
                aria-label={`${GROUP_LABELS[s.group]}`}
                aria-valuemin={0}
                aria-valuemax={data.total}
                aria-valuenow={s.count}
                aria-valuetext={`${s.count} of ${data.total} (${s.pct}%)`}
              >
                <div className={`h-full rounded-full ${GROUP_CLASSES[s.group].bg}`} style={{ width: `${(s.count / data.total) * 100}%` }} />
              </div>
              {data.detail[s.group].length > 1 || (s.group === 'other' && data.detail[s.group].length > 0) ? (
                <p className="mt-0.5 text-[11px] text-neutral-500">{data.detail[s.group].map((d) => `${d.label} ${d.count}`).join(' · ')}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto pt-3">
        <ViewLink to={to}>Open {title}</ViewLink>
      </div>
    </Panel>
  )
}

export function AttentionList({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
        <CheckIcon /> Nothing needs attention right now.
      </p>
    )
  }
  return (
    <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
      {items.map((i) => {
        const body = (
          <>
            <span className="rounded-md bg-amber-50 p-1.5 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
              <AlertIcon />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">{i.label}</span>
              <span className="block truncate text-xs text-neutral-500" title={i.detail}>
                {i.detail}
              </span>
            </span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-sm font-semibold tabular-nums text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
              {i.count}
            </span>
          </>
        )
        return (
          <li key={i.id}>
            {i.to ? (
              <Link to={i.to} className="flex items-center gap-3 rounded-md px-1 py-2.5 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-teal-600 dark:hover:bg-neutral-800" aria-label={`${i.label}: ${i.count}. ${i.detail}`}>
                {body}
              </Link>
            ) : (
              <div className="flex items-center gap-3 px-1 py-2.5">{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
