// Fills the STAGING project with realistic but entirely made-up data — no
// production record is read or copied. Every serial starts with "SYN-" and
// every person is "Test Employee NN", so staging data can never be
// mistaken for real company or employee data.
//
// Everything goes through the app's own functions, signed in as the
// staging admin (STAGING_ADMIN_EMAIL), in ONE transaction: it either all
// lands or none of it does. Includes a few deliberate duplicate-serial
// patterns (cross-collection, case, whitespace) for the later duplicate
// investigation.
//
//   npm run staging:seed
//   npm run staging:seed -- --large   also adds 1,120 extra history rows
//                                     (to see the backup export's 1,000-row
//                                     limit, audit finding C5, in the app)
//
// Refuses to run against production (see lib.mjs).
import { connectStagingDb, loadStagingEnv } from './lib.mjs'

const large = process.argv.includes('--large')
const env = loadStagingEnv(['STAGING_DB_URL', 'STAGING_ADMIN_EMAIL'])
const db = await connectStagingDb(env)
let exitCode = 0

const employee = (n) => `Test Employee ${String(n).padStart(2, '0')}`
const LAPTOPS = ['Dell Latitude 5440', 'Lenovo ThinkPad T14', 'HP EliteBook 840', 'Microsoft Surface Laptop 5']

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0]
}

try {
  const admin = await one(
    `select u.id, p.role from auth.users u left join public.profiles p on p.id = u.id where lower(u.email) = lower($1)`,
    [env.STAGING_ADMIN_EMAIL],
  )
  if (!admin) throw new Error(`No staging user with email ${env.STAGING_ADMIN_EMAIL}. Do step 6 of the guide first.`)
  if (admin.role !== 'admin') throw new Error(`${env.STAGING_ADMIN_EMAIL} is not an admin on staging (role: ${admin.role}). Do step 6 first.`)

  const already = await one(`select count(*)::int as n from serialized_assets where serial like 'SYN-%'`)
  if (already.n > 0) throw new Error('Synthetic data is already present on staging. Nothing to do.')

  await db.query('begin')
  // Act as the admin through the same JWT-claims mechanism PostgREST uses.
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: admin.id, role: 'authenticated', is_anonymous: false }),
  ])
  await db.query('set local role authenticated')

  const create = async (collection, name, category, serial, location = 'Tampa Office') =>
    (await one(`select create_asset($1::asset_collection, $2, $3, $4, 'available', null, $5) as id`, [
      collection, name, category, serial, location,
    ])).id
  const act = (collection, id, action, assignee = null, detail = null) =>
    one(`select perform_lifecycle_action($1::asset_collection, $2, $3::asset_action, $4, $5) as c`, [
      collection, id, action, assignee, detail,
    ])

  let emp = 1
  const counts = {}
  const bump = (k) => (counts[k] = (counts[k] ?? 0) + 1)

  // Laptop Inventory: 25 laptops; 5 provided (they move to Active Laptops),
  // 3 damaged, 1 nonfunctional, 2 retained.
  const inventory = []
  for (let i = 1; i <= 25; i++) {
    inventory.push(await create('serialized_assets', LAPTOPS[i % 4], 'Laptop', `SYN-INV-${String(i).padStart(3, '0')}`))
    bump('inventory laptops')
  }
  for (const id of inventory.slice(0, 5)) await act('serialized_assets', id, 'provide', employee(emp++))
  for (const id of inventory.slice(5, 8)) await act('serialized_assets', id, 'mark_damaged', null, 'synthetic: cracked screen')
  await act('serialized_assets', inventory[8], 'mark_damaged')
  await act('serialized_assets', inventory[8], 'mark_nonfunctional', null, 'synthetic: board failure')
  for (const id of inventory.slice(9, 11)) await act('serialized_assets', id, 'retain')

  // Active Laptops (NP) created directly there: 12, 8 provided.
  for (let i = 1; i <= 12; i++) {
    const id = await create('active_laptops_np', LAPTOPS[i % 4], 'Laptop', `SYN-NP-${String(i).padStart(3, '0')}`, 'Remote')
    if (i <= 8) await act('active_laptops_np', id, 'provide', employee(emp++))
    bump('NP laptops')
  }

  // Monitors: 15, 6 provided, 1 damaged.
  for (let i = 1; i <= 15; i++) {
    const id = await create('monitors', i % 2 ? 'Dell 24 Monitor' : 'LG 27 Monitor', 'Monitor', `SYN-MON-${String(i).padStart(3, '0')}`)
    if (i <= 6) await act('monitors', id, 'provide', employee(i))
    if (i === 15) await act('monitors', id, 'mark_damaged')
    bump('monitors')
  }

  // Other Equipment: 8, 2 provided.
  for (let i = 1; i <= 8; i++) {
    const id = await create('other_equipment', i % 2 ? 'USB-C Dock' : 'Headset', i % 2 ? 'Dock' : 'Headset', `SYN-OTH-${String(i).padStart(3, '0')}`)
    if (i <= 2) await act('other_equipment', id, 'provide', employee(i))
    bump('other equipment')
  }

  // Bulk Stock.
  for (const [name, category, qty, issued] of [
    ['Wireless Mouse', 'Accessory', 40, 12],
    ['USB-C Charger', 'Power', 30, 9],
    ['Keyboard', 'Accessory', 25, 4],
    ['HDMI Cable', 'Cable', 60, 15],
    ['Laptop Bag', 'Accessory', 20, 6],
  ]) {
    const id = (await one(`select create_bulk_item($1, $2, 'Tampa Office', $3) as id`, [name, category, qty])).id
    await one(`select perform_bulk_action($1, 'issue', $2) as x`, [id, issued])
    bump('bulk items')
  }

  // An import, so Import History has an entry.
  await one(`select commit_asset_import('monitors', 'synthetic-monitors.xlsx', $1::jsonb) as r`, [
    JSON.stringify(
      [1, 2, 3].map((i) => ({ serial: `SYN-IMP-${i}`, name: 'Dell 24 Monitor', category: 'Monitor', status: '', assigned_to: '', location: 'Tampa Office' })),
    ),
  ])
  bump('imports')

  // Onboarding / offboarding.
  for (let i = 0; i < 3; i++) {
    await one(`insert into onboarding_checklists (employee_name, created_by, identity_created) values ($1, $2, $3) returning id`, [
      employee(30 + i), admin.id, i > 0,
    ])
    bump('onboarding checklists')
  }
  for (const n of [1, 2]) {
    await one(`insert into offboarding_checklists (employee_name, created_by) values ($1, $2) returning id`, [employee(n), admin.id])
    bump('offboarding checklists')
  }
  // A legacy-style record with two laptop outcomes ticked (written through
  // the old flag columns), so the "needs review" handling from migration
  // 024 can be tested by hand.
  await one(
    `insert into offboarding_checklists (employee_name, created_by, removed_access, laptop_received, laptop_retained)
     values ('Test Employee 46 (legacy conflict)', $1, true, true, true) returning id`,
    [admin.id],
  )
  bump('offboarding checklists')

  if (large) {
    // 4 laptops x 140 damage/repair cycles = 1,120 history rows, run
    // server-side in one statement (still as the admin, still through the
    // lifecycle function). They end up Available again.
    await db.query(
      `do $$
       declare v_id uuid;
       begin
         for v_id in select id from serialized_assets where serial in ('SYN-INV-022','SYN-INV-023','SYN-INV-024','SYN-INV-025') loop
           for i in 1..140 loop
             perform perform_lifecycle_action('serialized_assets', v_id, 'mark_damaged', null, 'synthetic volume');
             perform perform_lifecycle_action('serialized_assets', v_id, 'mark_repaired', null, 'synthetic volume');
           end loop;
         end loop;
       end $$`,
    )
    counts['extra history rows (--large)'] = 1120
  }

  // Deliberate duplicate patterns (for the later duplicate investigation).
  await create('serialized_assets', 'Dell Latitude 5440', 'Laptop', 'SYN-DUP-A')
  await create('monitors', 'Dell 24 Monitor', 'Monitor', 'SYN-DUP-A') // same serial, two collections
  await create('other_equipment', 'USB-C Dock', 'Dock', 'SYN-DUP-B')
  await create('other_equipment', 'USB-C Dock', 'Dock', 'syn-dup-b') // differs only by case
  await create('active_laptops_np', 'Lenovo ThinkPad T14', 'Laptop', 'SYN-DUP-C')
  await create('active_laptops_np', 'Lenovo ThinkPad T14', 'Laptop', ' SYN-DUP-C') // leading space
  bump('duplicate patterns (3)')

  await db.query('commit')
  console.log('\n✔ Synthetic staging data created:')
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v}`)
} catch (err) {
  await db.query('rollback').catch(() => {})
  console.error(`\n✖ Seeding stopped — staging is unchanged.\n  ${err.message}\n`)
  exitCode = 1
} finally {
  await db.end()
}
process.exit(exitCode)
