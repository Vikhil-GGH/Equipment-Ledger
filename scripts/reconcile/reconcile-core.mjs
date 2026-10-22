// Compares the OLD app's data (a localStorage export) with the new database's rows (a production backup),
// READ-ONLY and OFFLINE: it never contacts any database and never changes either input. It only classifies:
//   same      matched by serial, status and assignee agree
//   changed   matched by serial, but status / assignee / location differ (a person decides which is right)
//   onlyOld   in the old app, not in the new database  -> candidates to import
//   onlyNew   in the new database, not in the old export -> information (entered later, or never in the old app)
//   duplicate the same serial more than once (old, new, or across)  -> a person decides; never auto-merged
//   noSerial  no serial to match on                       -> listed for a person
// Serial matching uses the database's own rule (case, spaces, look-alike whitespace ignored).

export const normSerial = (s) => String(s ?? '').replace(/ /g, ' ').trim().replace(/\s+/g, ' ').toUpperCase()
export const normName = (s) => String(s ?? '').replace(/ /g, ' ').trim().replace(/\s+/g, ' ').toLowerCase()

export const OLD_KEYS = { assets: 'assets', nextp: 'nextpAssets', monitors: 'monitorAssets', other: 'otherAssets', bulk: 'bulkItems', onboarding: 'onboardingCases' }

/** Accepts the file made by export-old-app.js (one or more, e.g. one per browser). Duplicates across files are reported, not merged. */
export function parseOldExports(files) {
  const out = { assets: [], nextp: [], monitors: [], other: [], bulk: [], onboarding: [], problems: [] }
  for (const { name, json } of files) {
    if (json?.format !== 'eqledger-localstorage-export-1') { out.problems.push(`${name}: not an export made by export-old-app.js`); continue }
    for (const [family, key] of Object.entries(OLD_KEYS)) {
      const v = json.data?.[key]
      if (v === undefined || v === null) continue
      if (!Array.isArray(v)) { out.problems.push(`${name}: ${key} is not a list`); continue }
      for (const item of v) out[family].push({ ...item, _src: name })
    }
  }
  return out
}

const deviceView = (o) => ({ serial: o.serial ?? '', key: normSerial(o.serial), status: String(o.status ?? '').toLowerCase(), assigned: o.assigned ?? '', location: o.location ?? '', name: o.name ?? '', category: o.category ?? '', history: Array.isArray(o.history) ? o.history.length : 0, src: o._src, store: o._store })
const rowView = (r, table, historyCount) => ({ serial: r.serial ?? '', key: normSerial(r.serial), status: String(r.status ?? '').toLowerCase(), assigned: r.assigned_to ?? '', location: r.location ?? '', name: r.name ?? '', category: r.category ?? '', history: historyCount.get(r.id) ?? 0, table, id: r.id })

function group(list) {
  const m = new Map()
  for (const x of list) m.set(x.key, [...(m.get(x.key) ?? []), x])
  return m
}

/** One family of devices: old items vs new rows. */
export function compareDevices(oldItems, newItems) {
  const noSerialOld = oldItems.filter((x) => !x.key)
  const noSerialNew = newItems.filter((x) => !x.key)
  const O = group(oldItems.filter((x) => x.key))
  const N = group(newItems.filter((x) => x.key))
  const res = { same: [], changed: [], onlyOld: [], onlyNew: [], duplicate: [], noSerialOld, noSerialNew }
  for (const [key, olds] of O) {
    const news = N.get(key) ?? []
    if (olds.length > 1 || news.length > 1) { res.duplicate.push({ key, old: olds, new: news }); continue }
    if (!news.length) { res.onlyOld.push(olds[0]); continue }
    const o = olds[0], n = news[0]
    const diffs = {}
    if (o.status !== n.status) diffs.status = [o.status, n.status]
    if (normName(o.assigned) !== normName(n.assigned)) diffs.assigned = [o.assigned, n.assigned]
    if (normName(o.location) !== normName(n.location)) diffs.location = [o.location, n.location]
    ;(Object.keys(diffs).length ? res.changed : res.same).push({ key, old: o, new: n, diffs })
  }
  for (const [key, news] of N) if (!O.has(key)) news.length > 1 ? res.duplicate.push({ key, old: [], new: news }) : res.onlyNew.push(news[0])
  return res
}

/**
 * @param old   parseOldExports(...) result
 * @param data  the backup's data.json ({ table: rows[] })
 */
export function reconcile(old, data) {
  const hist = (t) => new Map(Object.entries((data[t] ?? []).reduce((m, r) => ((m[r.asset_id] = (m[r.asset_id] ?? 0) + 1), m), {})))
  const hInv = hist('serialized_asset_history')
  const hNp = hist('active_laptops_np_history')
  const hMon = hist('monitors_history')
  const hOth = hist('other_equipment_history')
  const tag = (list, store) => list.map((x) => ({ ...x, _store: store }))
  const oldLaptops = [...tag(old.assets, 'assets'), ...tag(old.nextp, 'nextp')].map(deviceView)
  const newLaptops = [...(data.serialized_assets ?? []).map((r) => rowView(r, 'serialized_assets', hInv)), ...(data.active_laptops_np ?? []).map((r) => rowView(r, 'active_laptops_np', hNp))]
  const families = {
    laptops: compareDevices(oldLaptops, newLaptops),
    monitors: compareDevices(tag(old.monitors, 'monitors').map(deviceView), (data.monitors ?? []).map((r) => rowView(r, 'monitors', hMon))),
    other: compareDevices(tag(old.other, 'other').map(deviceView), (data.other_equipment ?? []).map((r) => rowView(r, 'other_equipment', hOth))),
  }
  // Bulk Stock and onboarding cases: matched by name (+category) and employee name; counts and gaps only.
  const bulkNew = new Map((data.bulk_items ?? []).map((b) => [normName(b.name) + '|' + normName(b.category), b]))
  const bulk = { onlyOld: [], inBoth: [], unusualBuckets: [] }
  for (const b of old.bulk) {
    const k = normName(b.name) + '|' + normName(b.category)
    const n = bulkNew.get(k)
    ;(n ? bulk.inBoth : bulk.onlyOld).push({ name: b.name, category: b.category, location: b.location, buckets: b.buckets ?? {}, new: n ? { available: n.available, provided: n.provided, retained: n.retained, damaged: n.damaged, decommissioned: n.decommissioned } : null })
    if (b.buckets && ['provided', 'retained', 'damaged', 'decommissioned'].some((x) => Number(b.buckets[x]) > 0)) bulk.unusualBuckets.push(b.name)
  }
  const onbNew = new Set((data.onboarding_checklists ?? []).map((c) => normName(c.employee_name)))
  const onboarding = { open: [], done: [], inNew: [] }
  for (const c of old.onboarding) {
    const done = !!c.steps?.onboardingSuccessful
    ;(onbNew.has(normName(c.employeeName)) ? onboarding.inNew : done ? onboarding.done : onboarding.open).push({ employeeName: c.employeeName, steps: c.steps ?? {}, created: c.created, updated: c.updated })
  }
  return { families, bulk, onboarding, counts: { old: Object.fromEntries(Object.entries(old).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])), problems: old.problems } }
}
