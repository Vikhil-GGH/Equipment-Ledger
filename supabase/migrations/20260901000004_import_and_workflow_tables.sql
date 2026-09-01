-- Audit log for Excel/paste imports, so a bulk import is traceable
-- alongside individual asset history entries (who, when, file, counts).
create table import_events (
  id uuid primary key default gen_random_uuid(),
  imported_by uuid references profiles (id),
  imported_at timestamptz not null default now(),
  target_collection text not null, -- 'serialized_assets' | 'active_laptops_np' | 'bulk_items'
  filename text not null,
  rows_created integer not null default 0,
  rows_updated integer not null default 0,
  rows_errored integer not null default 0,
  summary jsonb
);

create index on import_events (imported_at desc);

-- Onboarding: four-step checklist per new hire. Entering a serial number
-- (assigned_asset_id) auto-assigns that device via perform_lifecycle_action
-- and moves it into Active Laptops (NP) — see onboarding function, Phase 5.
create table onboarding_checklists (
  id uuid primary key default gen_random_uuid(),
  employee_name text not null,
  identity_created boolean not null default false,
  equipment_assigned boolean not null default false,
  required_access_provided boolean not null default false,
  onboarding_successful boolean not null default false,
  assigned_asset_id uuid references active_laptops_np (id),
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger onboarding_checklists_set_updated_at
  before update on onboarding_checklists
  for each row execute function set_updated_at();

-- Offboarding: search-by-employee-name checklist. The "Track" view (full
-- asset history for that employee) is computed live from the three ledger
-- tables' assigned_to/history rather than duplicated here.
create table offboarding_checklists (
  id uuid primary key default gen_random_uuid(),
  employee_name text not null,
  removed_access boolean not null default false,
  laptop_received boolean not null default false,
  laptop_retained boolean not null default false,
  laptop_decommissioned boolean not null default false,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on offboarding_checklists (employee_name);

create trigger offboarding_checklists_set_updated_at
  before update on offboarding_checklists
  for each row execute function set_updated_at();
