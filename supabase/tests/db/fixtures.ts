import { actAs, actAsDatabase, type Db, type TestUser } from './harness'

// Fixed ids so tests and failure messages are readable. Emails use the
// reserved .invalid TLD — never deliverable, never a real person.
export const ADMIN: TestUser = { id: '00000000-0000-4000-8000-00000000a001', email: 'sec-test-admin@example.invalid', anonymous: false }
export const EDITOR: TestUser = { id: '00000000-0000-4000-8000-00000000a002', email: 'sec-test-editor@example.invalid', anonymous: false }
export const VIEWER: TestUser = { id: '00000000-0000-4000-8000-00000000a003', email: 'sec-test-viewer@example.invalid', anonymous: false }
/** An anonymous demo user that signed up BEFORE 022 (so has a profiles row). */
export const ANON_LEGACY: TestUser = { id: '00000000-0000-4000-8000-00000000c001', email: null, anonymous: true }
/** An anonymous user that signs up AFTER 022. */
export const ANON_NEW: TestUser = { id: '00000000-0000-4000-8000-00000000c002', email: null, anonymous: true }

export const LEDGER_TABLES = [
  'serialized_assets',
  'active_laptops_np',
  'monitors',
  'other_equipment',
  'bulk_items',
  'serialized_asset_history',
  'active_laptops_np_history',
  'monitors_history',
  'other_equipment_history',
  'bulk_item_history',
  'onboarding_checklists',
  'offboarding_checklists',
  'import_events',
] as const

/**
 * LEDGER_TABLES plus the tables 20260901000026 added, when present — what a
 * full backup contains. (Staging may run these tests before 026 exists.)
 */
export async function backupTables(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ t: string }>(
    `select t from unnest(array['employees', 'equipment_issues', 'employee_history']) t where to_regclass('public.' || t) is not null`,
  )
  return [...LEDGER_TABLES, ...rows.map((r) => r.t)]
}

export const ASSET_TABLES = ['serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment'] as const

export const STATS_VIEWS = [
  'serialized_assets_stats',
  'active_laptops_np_stats',
  'monitors_stats',
  'other_equipment_stats',
] as const

async function insertAuthUser(db: Db, user: TestUser) {
  await db.query(
    `insert into auth.users (id, email, is_anonymous) values ($1, $2, $3) on conflict (id) do nothing`,
    [user.id, user.email, user.anonymous],
  )
}

/**
 * Creates the named non-anonymous users with their roles. Runs as the
 * database (no JWT), the same context an operator uses in the SQL editor.
 * Idempotent, so it works both on a fresh PGlite database and inside a
 * rolled-back transaction on staging.
 */
export async function seedUsers(db: Db) {
  await actAsDatabase(db)
  for (const [user, role] of [
    [ADMIN, 'admin'],
    [EDITOR, 'editor'],
    [VIEWER, 'viewer'],
  ] as const) {
    await insertAuthUser(db, user)
    await db.query(`update profiles set role = $2 where id = $1`, [user.id, role])
  }
}

/**
 * Pre-022 only: the legacy demo flow — handle_new_user (017) gives the
 * anonymous user an editor profile.
 */
export async function seedLegacyAnonymous(db: Db) {
  await actAsDatabase(db)
  await insertAuthUser(db, ANON_LEGACY)
}

/**
 * Post-022 equivalent of seedLegacyAnonymous, for staging: an anonymous
 * user whose profile row already exists (pinned to viewer, as 022 leaves
 * every legacy anonymous profile).
 */
export async function ensureLegacyAnonymousProfile(db: Db) {
  await actAsDatabase(db)
  await insertAuthUser(db, ANON_LEGACY)
  await db.query(
    `insert into profiles (id, email, role) values ($1::uuid, 'anonymous-' || $1::uuid::text, 'viewer') on conflict (id) do nothing`,
    [ANON_LEGACY.id],
  )
}

export async function addAnonymousUser(db: Db, user: TestUser) {
  await actAsDatabase(db)
  await insertAuthUser(db, user)
}

export interface LedgerIds {
  inventoryLaptop: string
  npLaptop: string
  spareInventoryLaptop: string
  monitor: string
  other: string
  bulkItem: string
  onboarding: string
  offboarding: string
}

async function rpc<T>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<{ v: T }>(`select ${sql} as v`, params)
  return rows[0].v
}

/** A small, realistic ledger created through the app's own RPCs, as the admin. */
export async function seedLedger(db: Db, tag: string): Promise<LedgerIds> {
  await actAs(db, ADMIN)
  const create = (collection: string, name: string, category: string, serial: string) =>
    rpc<string>(db, `create_asset($1::asset_collection, $2, $3, $4)`, [collection, name, category, serial])

  const inventoryLaptop = await create('serialized_assets', 'Dell Latitude 5440', 'Laptop', `${tag}-INV-1`)
  const spareInventoryLaptop = await create('serialized_assets', 'Dell Latitude 5440', 'Laptop', `${tag}-INV-2`)
  const npLaptop = await create('active_laptops_np', 'Lenovo ThinkPad T14', 'Laptop', `${tag}-NP-1`)
  await rpc(db, `perform_lifecycle_action('active_laptops_np', $1, 'provide', 'Test Employee A')`, [npLaptop])
  const monitor = await create('monitors', 'Dell 24 Monitor', 'Monitor', `${tag}-MON-1`)
  const other = await create('other_equipment', 'USB-C Dock', 'Dock', `${tag}-OTH-1`)
  const bulkItem = await rpc<string>(db, `create_bulk_item('Wireless Mouse', 'Accessory', null, 20)`)

  const onboarding = (
    await db.query<{ id: string }>(
      `insert into onboarding_checklists (employee_name, created_by) values ('Test Employee B', $1) returning id`,
      [ADMIN.id],
    )
  ).rows[0].id
  const offboarding = (
    await db.query<{ id: string }>(
      `insert into offboarding_checklists (employee_name, created_by) values ('Test Employee A', $1) returning id`,
      [ADMIN.id],
    )
  ).rows[0].id

  await actAsDatabase(db)
  return { inventoryLaptop, npLaptop, spareInventoryLaptop, monitor, other, bulkItem, onboarding, offboarding }
}

export { rpc }
