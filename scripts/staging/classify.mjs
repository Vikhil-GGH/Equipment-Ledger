// Classifies rows ADDED to staging since a snapshot: is each one an authorized
// synthetic test record, or unexpected? Pure functions — no database access —
// so the rules are unit-tested (classify.test.mjs).
//
// A new row is synthetic when it
//   1. contains a synthetic tag (e.g. "ZZ-ACC-1619"), case-insensitive, in any
//      text value; or
//   2. references (in any column) the id of a synthetic account or of another
//      new row already found to be synthetic — repeated until nothing changes,
//      so history rows, register rows, serial keys etc. follow their parent.
// Rows that pass but also reference an EXISTING account are reported
// separately: a synthetic actor must never act on a real account.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Every scalar value in a row, as strings (nested JSON included). */
function valuesOf(value, out = []) {
  if (value === null || value === undefined) return out
  if (Array.isArray(value)) for (const v of value) valuesOf(v, out)
  else if (typeof value === 'object') for (const v of Object.values(value)) valuesOf(v, out)
  else out.push(String(value))
  return out
}

/**
 * @param {object} input
 * @param {Record<string, object[]>} input.newRows   table -> rows added since the snapshot
 * @param {Record<string, string>} input.pk          table -> primary-key column
 * @param {string[]} input.tags                      synthetic tags
 * @param {string[]} input.syntheticIds              ids of synthetic accounts
 * @param {string[]} input.existingAccountIds        ids of accounts that existed at the snapshot
 */
export function classifyNewRows({ newRows, pk, tags, syntheticIds, existingAccountIds }) {
  const tagRe = tags.length ? new RegExp(tags.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null
  const synthetic = new Set(syntheticIds.map((s) => s.toLowerCase()))
  const existing = new Set(existingAccountIds.map((s) => s.toLowerCase()))
  const rows = Object.entries(newRows).flatMap(([table, list]) =>
    list.map((row) => ({ table, row, id: String(row[pk[table] ?? 'id'] ?? '').toLowerCase(), values: valuesOf(row) })),
  )
  const isSyn = new Map(rows.map((r) => [r, !!tagRe && r.values.some((v) => tagRe.test(v))]))
  for (const r of rows) if (isSyn.get(r) && r.id) synthetic.add(r.id)
  for (let changed = true; changed; ) {
    changed = false
    for (const r of rows) {
      if (isSyn.get(r)) continue
      if (r.values.some((v) => UUID.test(v) && synthetic.has(v.toLowerCase()))) {
        isSyn.set(r, true)
        if (r.id) synthetic.add(r.id)
        changed = true
      }
    }
  }
  const result = {}
  for (const r of rows) {
    const t = (result[r.table] ??= { added: 0, synthetic: 0, unexpected: [], touchesExistingAccount: [] })
    t.added++
    if (!isSyn.get(r)) t.unexpected.push(r.row)
    else {
      t.synthetic++
      if (r.values.some((v) => UUID.test(v) && existing.has(v.toLowerCase()))) t.touchesExistingAccount.push(r.row)
    }
  }
  return result
}
