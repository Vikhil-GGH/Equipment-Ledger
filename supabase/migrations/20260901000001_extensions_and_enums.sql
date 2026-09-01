-- Extensions
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- Roles
create type user_role as enum ('admin', 'editor', 'viewer', 'scanner');

-- Serialized asset lifecycle status.
-- IMPORTANT semantic note (deliberate product decision, not an oversight):
--   'decommissioned' = employee separated from the company; device is refreshed
--     and returns to the reissue pool. It is NOT terminal.
--   'nonfunctional'  = the actual terminal state (device broken beyond repair).
create type asset_status as enum (
  'available',
  'provided',
  'retained',
  'damaged',
  'decommissioned',
  'nonfunctional'
);

-- Actions that mutate a serialized asset / active laptop (NP) status.
-- 'swap' is intentionally excluded: it mutates two rows atomically and is
-- handled by its own function (perform_swap) rather than perform_lifecycle_action.
create type asset_action as enum (
  'provide',
  'retain',
  'mark_damaged',
  'collect',
  'transfer',
  'decommission',
  'mark_repaired',
  'mark_nonfunctional'
);

-- Which of the two "serialized" collections a function call targets.
-- Both tables share an identical schema; this lets lifecycle logic live in
-- one place instead of being duplicated per collection.
create type asset_collection as enum (
  'serialized_assets',
  'active_laptops_np'
);

-- Bulk Stock bucket names.
create type bulk_bucket as enum (
  'available',
  'provided',
  'retained',
  'damaged',
  'decommissioned'
);

-- Bulk Stock actions.
create type bulk_action as enum (
  'receive_stock',
  'issue',
  'return',
  'retain',
  'mark_damaged',
  'repair',
  'decommission'
);
