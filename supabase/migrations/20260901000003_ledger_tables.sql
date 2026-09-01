-- =========================================================================
-- Serialized Assets — general company device inventory (e.g. "Tampa Office")
-- =========================================================================
create table serialized_assets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  serial text not null,
  status asset_status not null default 'available',
  assigned_to text,
  location text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (serial)
);

create table serialized_asset_history (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references serialized_assets (id) on delete cascade,
  date timestamptz not null default now(),
  action text not null,
  detail text,
  actor_user_id uuid references profiles (id)
);

create index on serialized_asset_history (asset_id);
create index on serialized_assets (status);
create index on serialized_assets (serial);

create trigger serialized_assets_set_updated_at
  before update on serialized_assets
  for each row execute function set_updated_at();

-- =========================================================================
-- Active Laptops (NP) — laptops supported by the "Next Perimeter" vendor.
-- Identical schema/lifecycle to Serialized Assets, kept as a separate table
-- on purpose: it's a distinct support relationship, not a UI filter.
-- Note: the 'provided' status is displayed as "Active" in this collection's
-- UI only — the underlying enum value is unchanged, this is a label swap
-- in the frontend, not a schema difference.
-- =========================================================================
create table active_laptops_np (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  serial text not null,
  status asset_status not null default 'available',
  assigned_to text,
  location text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (serial)
);

create table active_laptops_np_history (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references active_laptops_np (id) on delete cascade,
  date timestamptz not null default now(),
  action text not null,
  detail text,
  actor_user_id uuid references profiles (id)
);

create index on active_laptops_np_history (asset_id);
create index on active_laptops_np (status);
create index on active_laptops_np (serial);

create trigger active_laptops_np_set_updated_at
  before update on active_laptops_np
  for each row execute function set_updated_at();

-- =========================================================================
-- Bulk Stock — accessories tracked by quantity, not serial (mice, chargers,
-- headphones). Quantities live in named bucket columns rather than a
-- separate ledger table so bucket totals can never go negative or drift
-- (enforced by the check constraint below); every mutation still gets a
-- history row via perform_bulk_action.
-- =========================================================================
create table bulk_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  location text,
  available integer not null default 0,
  provided integer not null default 0,
  retained integer not null default 0,
  damaged integer not null default 0,
  decommissioned integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bulk_items_nonnegative check (
    available >= 0 and provided >= 0 and retained >= 0
    and damaged >= 0 and decommissioned >= 0
  )
);

create table bulk_item_history (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references bulk_items (id) on delete cascade,
  date timestamptz not null default now(),
  action text not null,
  detail text,
  quantity integer not null,
  actor_user_id uuid references profiles (id)
);

create index on bulk_item_history (item_id);

create trigger bulk_items_set_updated_at
  before update on bulk_items
  for each row execute function set_updated_at();
