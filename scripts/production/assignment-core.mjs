// Guarded application of the reviewed assignment change list (old-app assignees for devices that are
// 'available' and unassigned in production). Plain functions over the same tiny db interface as apply-core.mjs
// ({ query(sql, params) -> { rows }, exec(sql) }), so the exact code that is rehearsed on the restored backup is the
// code the owner runs (apply-assignments.mjs). It uses the app's own state machine (perform_lifecycle_action 'provide'),
// so every change gets its normal history entry. It never creates, deletes or merges a device.
//
// Everything runs in ONE transaction. Without execute:true it ends in a rollback (a dry run that still proves every
// call works); with execute:true it commits only after every check below has passed.
export const EXPECTED_VERSION = '20260901000035' // the last migration of the chain; the function must be in its final form
export const EXCLUDED_SERIALS = ['CND4420J3Z'] // owner decision: needs investigation, never applied here
export const NOTE = 'Assignment carried over from the old app (reviewed)'
const TABLES = ['serialized_assets', 'active_laptops_np']
const HISTORY = { serialized_assets: 'serialized_asset_history', active_laptops_np: 'active_laptops_np_history' } // migration 011
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase()

/** Validates the change list file itself (no database). Returns the list of problems (empty = fine). */
export function checkPlan(plan, expectCount) {
  const bad = []
  const ch = plan?.changes
  if (!Array.isArray(ch)) return ['change list has no "changes" array']
  if (ch.length !== expectCount) bad.push(`change list has ${ch.length} changes, expected ${expectCount}`)
  const ids = new Set()
  const serials = new Set()
  for (const c of ch) {
    if (!TABLES.includes(c.production_table)) bad.push(`${c.serial}: unknown table ${c.production_table}`)
    if (!c.production_id || !c.serial || !String(c.new_assignee ?? '').trim()) bad.push(`${c.serial}: id, serial or assignee missing`)
    if (c.issues?.length) bad.push(`${c.serial}: still has issues (${c.issues.join('; ')})`)
    if (EXCLUDED_SERIALS.includes(norm(c.serial))) bad.push(`${c.serial}: is on the exclusion list`)
    if (ids.has(c.production_id)) bad.push(`${c.serial}: duplicate id`)
    if (serials.has(norm(c.serial))) bad.push(`${c.serial}: duplicate serial in the list`)
    ids.add(c.production_id)
    serials.add(norm(c.serial))
  }
  return bad
}

/** Returns { applied, committed, respelled, totals }; throws (after rolling back) on any failed check. */
export async function applyAssignments(db, plan, { expectCount, execute = false } = {}) {
  const problems = checkPlan(plan, expectCount)
  if (problems.length) throw new Error('Refusing: ' + problems.join(' | '))
  await db.exec('begin')
  try {
    const recorded = (await db.query(`select count(*)::int n from supabase_migrations.schema_migrations where version = $1`, [EXPECTED_VERSION])).rows[0].n
    if (recorded !== 1) throw new Error(`Migration ${EXPECTED_VERSION} is not recorded: apply the whole migration chain first`)
    const admins = (await db.query(`select id from profiles where role = 'admin' and access_revoked_at is null`)).rows
    if (admins.length !== 1) throw new Error(`Expected exactly one active admin to act as, found ${admins.length}`)

    // Preconditions, row by row, on the live data (locked until the end of the transaction).
    for (const c of plan.changes) {
      const r = (await db.query(`select serial, status, assigned_to from ${c.production_table} where id = $1 for update`, [c.production_id])).rows
      if (r.length !== 1) throw new Error(`${c.serial}: row ${c.production_id} not found in ${c.production_table}`)
      if (norm(r[0].serial) !== norm(c.serial)) throw new Error(`${c.serial}: the row's serial is ${r[0].serial}`)
      if (r[0].status !== 'available' || String(r[0].assigned_to ?? '').trim())
        throw new Error(`${c.serial}: no longer available and unassigned (status ${r[0].status}, assignee "${r[0].assigned_to ?? ''}")`)
    }
    // inventory laptops move into the active table when provided, so the check is the laptop total plus monitors
    const total = async () => ({
      laptops: (await db.query(`select (select count(*) from serialized_assets)::int + (select count(*) from active_laptops_np)::int n`)).rows[0].n,
      monitors: (await db.query(`select count(*)::int n from monitors`)).rows[0].n,
    })
    const totalsBefore = await total()
    const dupBefore = (await db.query(`select count(*)::int n from serial_duplicate_candidates`)).rows[0].n

    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: admins[0].id, role: 'authenticated', aal: 'aal2', is_anonymous: false })])
    await db.exec('set local role authenticated')
    for (const c of plan.changes)
      await db.query(`select perform_lifecycle_action($1::asset_collection, $2, 'provide', $3, $4)`, [c.production_table, c.production_id, c.new_assignee.trim(), NOTE])
    await db.exec('reset role')
    await db.query(`select set_config('request.jwt.claims', '', true)`)

    // Verification, still inside the transaction: any difference aborts it.
    const respelled = []
    for (const c of plan.changes) {
      // providing an inventory laptop moves it into the active-laptops table, so look the serial up in both
      const hits = []
      for (const t of TABLES) for (const x of (await db.query(`select status, assigned_to from ${t} where upper(btrim(serial)) = $1`, [norm(c.serial)])).rows) hits.push(x)
      if (hits.length !== 1) throw new Error(`${c.serial}: found in ${hits.length} places after the change (must be exactly 1)`)
      const r = hits[0]
      // the database reuses an already-recorded spelling of the same name (migration 033); only case may differ
      if (r.status !== 'provided' || norm(r.assigned_to) !== norm(c.new_assignee)) throw new Error(`${c.serial}: ended as ${r.status} / "${r.assigned_to}"`)
      if (r.assigned_to !== c.new_assignee.trim()) respelled.push(`${c.serial}: "${c.new_assignee}" -> "${r.assigned_to}"`)
    }
    let entries = 0
    for (const t of TABLES) entries += (await db.query(`select count(*)::int n from ${HISTORY[t]} where action = 'provide' and detail = $1`, [NOTE])).rows[0].n
    if (entries !== plan.changes.length) throw new Error(`Expected ${plan.changes.length} history entries, found ${entries}`)
    const totalsAfter = await total()
    if (JSON.stringify(totalsAfter) !== JSON.stringify(totalsBefore)) throw new Error('Device counts changed: ' + JSON.stringify({ before: totalsBefore, after: totalsAfter }))
    const dupAfter = (await db.query(`select count(*)::int n from serial_duplicate_candidates`)).rows[0].n
    if (dupAfter !== dupBefore) throw new Error('Duplicate-candidate rows changed')

    await db.exec(execute ? 'commit' : 'rollback')
    return { applied: plan.changes.length, committed: execute, respelled, totals: totalsAfter }
  } catch (err) {
    await db.exec('rollback').catch(() => undefined)
    throw err
  }
}
