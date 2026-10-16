import { useAuth } from '../features/auth/useAuth'
import { useDashboardData } from '../features/dashboard/useDashboardData'
import { DonutChart, EquipmentComparison, type ComparisonRow } from '../features/dashboard/charts'
import { AttentionList, KpiCard, Panel, SummaryCard, ViewLink } from '../features/dashboard/cards'
import { BoxIcon, CheckIcon, LaptopIcon, LayersIcon, MonitorIcon, StackIcon, UserIcon } from '../features/dashboard/icons'
import type { StatusGroup } from '../features/dashboard/statusColors'
import { Link } from 'react-router-dom'

const laptopTabLink = (g: StatusGroup) => `/laptops?tab=${g}`

export function DashboardPage() {
  const { profile } = useAuth()
  const { model, sections } = useDashboardData()
  const k = model.kpis
  const laptopsLoading = sections.laptops.loading
  const devicesLoading = laptopsLoading || sections.monitors.loading || sections.other.loading

  const comparison: ComparisonRow[] = [
    { key: 'laptops', label: 'Laptops', unit: 'devices', data: model.laptops, to: laptopTabLink },
    { key: 'monitors', label: 'Monitors', unit: 'devices', data: model.monitors, to: () => '/monitors' },
    { key: 'other', label: 'Other Equipment', unit: 'devices', data: model.other, to: () => '/other-equipment' },
    { key: 'bulk', label: 'Bulk Stock', unit: 'units', data: model.bulk, to: () => '/bulk-stock' },
  ]
  const comparisonError = sections.laptops.error ?? sections.monitors.error ?? sections.other.error ?? sections.bulk.error

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Overview</h1>
          <p className="text-sm text-neutral-500">
            Welcome, {profile?.full_name ?? profile?.email} · signed in as <span className="font-medium">{profile?.role}</span>
          </p>
        </div>
      </header>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Total laptops"
          value={k.totalLaptops}
          icon={<LaptopIcon />}
          tone="bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400"
          to="/laptops"
          loading={laptopsLoading}
          secondary={`${model.ownership.np} NP-managed · ${model.ownership.company} Company`}
        />
        <KpiCard
          label="Available laptops"
          value={k.availableLaptops}
          icon={<CheckIcon />}
          tone="bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
          to="/laptops?tab=available"
          loading={laptopsLoading}
          secondary={`${k.availablePct}% of laptops ready to issue`}
        />
        <KpiCard
          label="Assigned laptops"
          value={k.assignedLaptops}
          icon={<UserIcon />}
          tone="bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400"
          to="/laptops?tab=active"
          loading={laptopsLoading}
          secondary={`${k.assignedPct}% of laptops with employees`}
        />
        <KpiCard
          label="Total tracked equipment"
          value={k.trackedDevices}
          icon={<StackIcon />}
          tone="bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400"
          loading={devicesLoading}
          secondary={
            <>
              {k.totalLaptops} laptops · {k.monitors} monitors · {k.otherEquipment} other
              {!sections.bulk.loading && (
                <span className="block">
                  plus {k.bulkUnits} bulk units in {k.bulkItems} {k.bulkItems === 1 ? 'item' : 'items'} (counted separately)
                </span>
              )}
            </>
          }
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Laptop Inventory" loading={laptopsLoading} error={sections.laptops.error} action={<ViewLink to="/laptops">View all</ViewLink>}>
          {model.laptops.total === 0 ? (
            <p className="text-sm text-neutral-500">No laptops recorded yet.</p>
          ) : (
            <DonutChart data={model.laptops} unit="laptops" hrefFor={laptopTabLink} label="Laptops by status" />
          )}
        </Panel>
        <Panel title="Equipment by status" className="lg:col-span-2" loading={devicesLoading || sections.bulk.loading} error={comparisonError}>
          <EquipmentComparison rows={comparison} />
          <p className="mt-3 text-xs text-neutral-500">
            Each bar is 100% of its category. Laptops, monitors and other equipment are counted as individual devices;
            Bulk Stock is unit quantities.
          </p>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Laptop ownership" loading={laptopsLoading} error={sections.laptops.error}>
          {model.laptops.total === 0 ? (
            <p className="text-sm text-neutral-500">No laptops recorded yet.</p>
          ) : (
            <Ownership np={model.ownership.np} company={model.ownership.company} npPct={model.ownership.npPct} companyPct={model.ownership.companyPct} />
          )}
        </Panel>
        <Panel title="Attention required" className="lg:col-span-2" loading={sections.attention.loading} error={sections.attention.error}>
          <AttentionList items={model.attention} />
        </Panel>
      </div>

      {/* Category summaries */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <SummaryCard title="Monitors" icon={<MonitorIcon />} data={model.monitors} unit="devices" to="/monitors" loading={sections.monitors.loading} error={sections.monitors.error} />
        <SummaryCard title="Other Equipment" icon={<BoxIcon />} data={model.other} unit="devices" to="/other-equipment" loading={sections.other.loading} error={sections.other.error} />
        <SummaryCard
          title="Bulk Stock"
          icon={<LayersIcon />}
          data={model.bulk}
          unit="units"
          to="/bulk-stock"
          loading={sections.bulk.loading}
          error={sections.bulk.error}
          note={`${k.bulkItems} ${k.bulkItems === 1 ? 'item' : 'items'} · quantities, not individual devices`}
        />
      </div>
    </div>
  )
}

function Ownership({ np, company, npPct, companyPct }: { np: number; company: number; npPct: number; companyPct: number }) {
  const total = np + company
  return (
    <div>
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`NP-managed ${np} (${npPct}%), Company ${company} (${companyPct}%)`}>
        {np > 0 && <span className="h-full bg-indigo-500" style={{ width: `${(np / total) * 100}%` }} />}
        {company > 0 && <span className="h-full bg-teal-500" style={{ width: `${(company / total) * 100}%` }} />}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Link to="/laptops?scope=np" className="rounded-lg bg-indigo-50 px-3 py-2 hover:bg-indigo-100 focus-visible:outline-2 focus-visible:outline-teal-600 dark:bg-indigo-950/40 dark:hover:bg-indigo-950/70">
          <span className="block text-xs text-indigo-700 dark:text-indigo-300">NP-managed</span>
          <span className="text-xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">{np}</span>
          <span className="ml-1 text-xs text-neutral-500">{npPct}%</span>
        </Link>
        <Link to="/laptops?scope=company" className="rounded-lg bg-teal-50 px-3 py-2 hover:bg-teal-100 focus-visible:outline-2 focus-visible:outline-teal-600 dark:bg-teal-950/40 dark:hover:bg-teal-950/70">
          <span className="block text-xs text-teal-700 dark:text-teal-300">Company-owned</span>
          <span className="text-xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">{company}</span>
          <span className="ml-1 text-xs text-neutral-500">{companyPct}%</span>
        </Link>
      </div>
      <p className="mt-2 text-xs text-neutral-500">Company laptops temporarily held in Active Laptops (NP) while assigned count as Company.</p>
    </div>
  )
}
