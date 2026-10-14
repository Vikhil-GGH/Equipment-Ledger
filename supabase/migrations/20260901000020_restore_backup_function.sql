-- =========================================================================
-- Full-replace backup restore. Admin-only, deliberately destructive: wipes
-- every ledger/checklist/bulk-stock/import-log row and replaces it with the
-- contents of the uploaded backup JSON (produced client-side by the Data
-- page's "Export backup", which just SELECTs every table below — no export
-- RPC needed since RLS already lets an admin read all of it).
--
-- "Full replace" (not merge) was a deliberate choice: restoring is meant to
-- mean "return to exactly this snapshot," not merge two datasets together.
-- profiles/auth.users are NOT touched — a backup restores ledger data, not
-- who has accounts or what role they hold.
--
-- actor_user_id / created_by / imported_by references are nulled out (via
-- the left joins below) rather than failing the whole restore, since the
-- profile that made a given change may no longer exist by restore time
-- (this app's temporary public-demo mode churns through anonymous
-- profiles constantly — see 20260901000017_anonymous_public_demo.sql).
-- =========================================================================
create function restore_backup(p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Only an admin can restore a backup';
  end if;

  -- Clear current data. Order matters where a foreign key isn't
  -- ON DELETE CASCADE: onboarding_checklists.assigned_asset_id references
  -- active_laptops_np with no cascade, so checklists must go first. Every
  -- *_history table cascades from its parent asset/item table, so deleting
  -- serialized_assets/active_laptops_np/monitors/other_equipment/bulk_items
  -- clears their history automatically.
  delete from onboarding_checklists;
  delete from offboarding_checklists;
  delete from import_events;
  delete from serialized_assets;
  delete from active_laptops_np;
  delete from monitors;
  delete from other_equipment;
  delete from bulk_items;

  -- ------------------------------------------------------------- assets
  insert into serialized_assets (id, name, category, serial, status, assigned_to, location, created_at, updated_at)
  select id, name, category, serial, status, assigned_to, location, created_at, updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'serialized_assets', '[]'::jsonb))
    as t(id uuid, name text, category text, serial text, status asset_status,
         assigned_to text, location text, created_at timestamptz, updated_at timestamptz);

  -- moved_from_inventory defaults to false via coalesce so a backup taken
  -- before 20260901000021_inventory_active_laptop_moves.sql (which added
  -- the column) still restores cleanly.
  insert into active_laptops_np (id, name, category, serial, status, assigned_to, location, created_at, updated_at, moved_from_inventory)
  select id, name, category, serial, status, assigned_to, location, created_at, updated_at, coalesce(moved_from_inventory, false)
  from jsonb_to_recordset(coalesce(p_payload -> 'active_laptops_np', '[]'::jsonb))
    as t(id uuid, name text, category text, serial text, status asset_status,
         assigned_to text, location text, created_at timestamptz, updated_at timestamptz, moved_from_inventory boolean);

  insert into monitors (id, name, category, serial, status, assigned_to, location, created_at, updated_at)
  select id, name, category, serial, status, assigned_to, location, created_at, updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'monitors', '[]'::jsonb))
    as t(id uuid, name text, category text, serial text, status asset_status,
         assigned_to text, location text, created_at timestamptz, updated_at timestamptz);

  insert into other_equipment (id, name, category, serial, status, assigned_to, location, created_at, updated_at)
  select id, name, category, serial, status, assigned_to, location, created_at, updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'other_equipment', '[]'::jsonb))
    as t(id uuid, name text, category text, serial text, status asset_status,
         assigned_to text, location text, created_at timestamptz, updated_at timestamptz);

  insert into bulk_items (id, name, category, location, available, provided, retained, damaged, decommissioned, created_at, updated_at)
  select id, name, category, location, available, provided, retained, damaged, decommissioned, created_at, updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'bulk_items', '[]'::jsonb))
    as t(id uuid, name text, category text, location text, available int, provided int,
         retained int, damaged int, decommissioned int, created_at timestamptz, updated_at timestamptz);

  -- ------------------------------------------------------------ history
  insert into serialized_asset_history (id, asset_id, date, action, detail, actor_user_id)
  select t.id, t.asset_id, t.date, t.action, t.detail, p.id
  from jsonb_to_recordset(coalesce(p_payload -> 'serialized_asset_history', '[]'::jsonb))
    as t(id uuid, asset_id uuid, date timestamptz, action text, detail text, actor_user_id uuid)
  left join profiles p on p.id = t.actor_user_id;

  insert into active_laptops_np_history (id, asset_id, date, action, detail, actor_user_id)
  select t.id, t.asset_id, t.date, t.action, t.detail, p.id
  from jsonb_to_recordset(coalesce(p_payload -> 'active_laptops_np_history', '[]'::jsonb))
    as t(id uuid, asset_id uuid, date timestamptz, action text, detail text, actor_user_id uuid)
  left join profiles p on p.id = t.actor_user_id;

  insert into monitors_history (id, asset_id, date, action, detail, actor_user_id)
  select t.id, t.asset_id, t.date, t.action, t.detail, p.id
  from jsonb_to_recordset(coalesce(p_payload -> 'monitors_history', '[]'::jsonb))
    as t(id uuid, asset_id uuid, date timestamptz, action text, detail text, actor_user_id uuid)
  left join profiles p on p.id = t.actor_user_id;

  insert into other_equipment_history (id, asset_id, date, action, detail, actor_user_id)
  select t.id, t.asset_id, t.date, t.action, t.detail, p.id
  from jsonb_to_recordset(coalesce(p_payload -> 'other_equipment_history', '[]'::jsonb))
    as t(id uuid, asset_id uuid, date timestamptz, action text, detail text, actor_user_id uuid)
  left join profiles p on p.id = t.actor_user_id;

  insert into bulk_item_history (id, item_id, date, action, detail, quantity, actor_user_id)
  select t.id, t.item_id, t.date, t.action, t.detail, t.quantity, p.id
  from jsonb_to_recordset(coalesce(p_payload -> 'bulk_item_history', '[]'::jsonb))
    as t(id uuid, item_id uuid, date timestamptz, action text, detail text, quantity int, actor_user_id uuid)
  left join profiles p on p.id = t.actor_user_id;

  -- --------------------------------------------------------- checklists
  insert into onboarding_checklists
    (id, employee_name, identity_created, equipment_assigned, required_access_provided,
     onboarding_successful, assigned_asset_id, created_by, created_at, updated_at)
  select t.id, t.employee_name, t.identity_created, t.equipment_assigned, t.required_access_provided,
         t.onboarding_successful, a.id, p.id, t.created_at, t.updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'onboarding_checklists', '[]'::jsonb))
    as t(id uuid, employee_name text, identity_created boolean, equipment_assigned boolean,
         required_access_provided boolean, onboarding_successful boolean, assigned_asset_id uuid,
         created_by uuid, created_at timestamptz, updated_at timestamptz)
  left join active_laptops_np a on a.id = t.assigned_asset_id
  left join profiles p on p.id = t.created_by;

  insert into offboarding_checklists
    (id, employee_name, removed_access, laptop_received, laptop_retained, laptop_decommissioned,
     created_by, created_at, updated_at)
  select t.id, t.employee_name, t.removed_access, t.laptop_received, t.laptop_retained,
         t.laptop_decommissioned, p.id, t.created_at, t.updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'offboarding_checklists', '[]'::jsonb))
    as t(id uuid, employee_name text, removed_access boolean, laptop_received boolean,
         laptop_retained boolean, laptop_decommissioned boolean, created_by uuid,
         created_at timestamptz, updated_at timestamptz)
  left join profiles p on p.id = t.created_by;

  insert into import_events
    (id, imported_by, imported_at, target_collection, filename, rows_created, rows_updated, rows_errored, summary)
  select t.id, p.id, t.imported_at, t.target_collection, t.filename, t.rows_created, t.rows_updated, t.rows_errored, t.summary
  from jsonb_to_recordset(coalesce(p_payload -> 'import_events', '[]'::jsonb))
    as t(id uuid, imported_by uuid, imported_at timestamptz, target_collection text, filename text,
         rows_created int, rows_updated int, rows_errored int, summary jsonb)
  left join profiles p on p.id = t.imported_by;
end;
$$;
