-- =========================================================================
-- Rollback for 20260901000026_employee_equipment_register.sql
--
-- Removes the register, employees and the new checklist columns, and
-- restores commit_asset_import (as in 20260901000019) and restore_backup
-- (as in 20260901000024) exactly. Every pre-026 row, column and history
-- entry is untouched. What 026 created is copied to private.* first, so
-- nothing recorded since is destroyed:
--   private.employees_backup_026, private.equipment_issues_backup_026,
--   private.onboarding_equipment_backup_026 (employee link, requested
--   laptop, charger/headset answers), private.offboarding_employee_backup_026.
-- The onboarding -> active_laptops_np link is re-added NOT VALID so existing
-- rows (which may point at a laptop now in Inventory) can't make it fail;
-- note this brings back audit bug C2 for new rows.
--
-- Run BEFORE 20260901000025_down.sql, inside a transaction.
-- Not in supabase/migrations/ — never auto-applied.
-- =========================================================================
create schema if not exists private;
-- Enum columns are kept as text so the types can be dropped below. Each
-- rollback appends (backed_up_at), so a later re-apply + rollback keeps
-- earlier copies.
create table if not exists private.employees_backup_026 as
  select now() as backed_up_at, id, full_name, email, created_by, created_at from employees limit 0;
insert into private.employees_backup_026 select now(), id, full_name, email, created_by, created_at from employees;
create table if not exists private.equipment_issues_backup_026 as
  select now() as backed_up_at, id, employee_id, assignee_name, employee_ambiguous, item_kind, asset_collection::text as asset_collection,
         asset_id, bulk_item_id, quantity, description, serial, issued_at, issued_by, onboarding_id, status::text as status,
         closed_at, closed_by, close_note, approved_by, offboarding_id, source, created_at
  from equipment_issues limit 0;
insert into private.equipment_issues_backup_026
  select now(), id, employee_id, assignee_name, employee_ambiguous, item_kind, asset_collection::text, asset_id, bulk_item_id,
         quantity, description, serial, issued_at, issued_by, onboarding_id, status::text, closed_at, closed_by, close_note,
         approved_by, offboarding_id, source, created_at
  from equipment_issues;
create table if not exists private.onboarding_equipment_backup_026 as
  select now() as backed_up_at, id, employee_id, requested_laptop, charger_required::text as charger_required,
         headset_required::text as headset_required from onboarding_checklists limit 0;
insert into private.onboarding_equipment_backup_026
  select now(), id, employee_id, requested_laptop, charger_required::text, headset_required::text from onboarding_checklists;
create table if not exists private.offboarding_employee_backup_026 as
  select now() as backed_up_at, id, employee_id from offboarding_checklists limit 0;
insert into private.offboarding_employee_backup_026 select now(), id, employee_id from offboarding_checklists;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment'] loop
    execute format('drop trigger %I on %I', v_table || '_sync_register_insert', v_table);
    execute format('drop trigger %I on %I', v_table || '_sync_register_update', v_table);
  end loop;
end $$;

create or replace function commit_asset_import(
  p_collection asset_collection,
  p_filename text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table text := p_collection::text;
  v_history_table text := case p_collection
    when 'serialized_assets' then 'serialized_asset_history'
    when 'active_laptops_np' then 'active_laptops_np_history'
    when 'monitors' then 'monitors_history'
    when 'other_equipment' then 'other_equipment_history'
  end;
  v_actor uuid := auth.uid();
  v_role user_role;
  v_row jsonb;
  v_id uuid;
  v_created int := 0;
  v_updated int := 0;
begin
  select role into v_role from profiles where id = v_actor;
  if v_role is null or v_role not in ('admin', 'editor') then
    raise exception 'Not authorized to import';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    execute format('select id from %I where serial = $1', v_table)
      into v_id
      using (v_row ->> 'serial');

    if v_id is null then
      execute format(
        'insert into %I (name, category, serial, status, assigned_to, location) values ($1,$2,$3,$4,$5,$6) returning id',
        v_table
      )
      into v_id
      using
        v_row ->> 'name',
        v_row ->> 'category',
        v_row ->> 'serial',
        coalesce(nullif(v_row ->> 'status', ''), 'available')::asset_status,
        nullif(v_row ->> 'assigned_to', ''),
        nullif(v_row ->> 'location', '');

      execute format(
        'insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)',
        v_history_table
      ) using v_id, 'created', 'Imported from ' || p_filename, v_actor;

      v_created := v_created + 1;
    else
      execute format(
        'update %I set name = $1, category = $2, status = $3, assigned_to = $4, location = $5 where id = $6',
        v_table
      )
      using
        v_row ->> 'name',
        v_row ->> 'category',
        coalesce(nullif(v_row ->> 'status', ''), 'available')::asset_status,
        nullif(v_row ->> 'assigned_to', ''),
        nullif(v_row ->> 'location', ''),
        v_id;

      execute format(
        'insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)',
        v_history_table
      ) using v_id, 'imported', 'Updated via import from ' || p_filename, v_actor;

      v_updated := v_updated + 1;
    end if;
  end loop;

  insert into import_events
    (imported_by, target_collection, filename, rows_created, rows_updated, rows_errored, summary)
  values
    (v_actor, v_table, p_filename, v_created, v_updated, 0, jsonb_build_object('total', v_created + v_updated));

  return jsonb_build_object('created', v_created, 'updated', v_updated);
end;
$$;

create or replace function restore_backup(p_payload jsonb)
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

  -- laptop_outcome / outcome_needs_review come from backups taken after
  -- 20260901000024; for older backups they are null and the
  -- sync_offboarding_laptop_outcome trigger derives them from the legacy flags.
  insert into offboarding_checklists
    (id, employee_name, removed_access, laptop_received, laptop_retained, laptop_decommissioned,
     laptop_outcome, outcome_needs_review, created_by, created_at, updated_at)
  select t.id, t.employee_name, t.removed_access, t.laptop_received, t.laptop_retained,
         t.laptop_decommissioned, t.laptop_outcome, coalesce(t.outcome_needs_review, false),
         p.id, t.created_at, t.updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'offboarding_checklists', '[]'::jsonb))
    as t(id uuid, employee_name text, removed_access boolean, laptop_received boolean,
         laptop_retained boolean, laptop_decommissioned boolean,
         laptop_outcome offboarding_laptop_outcome, outcome_needs_review boolean, created_by uuid,
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

drop function return_equipment(uuid, equipment_issue_status, integer, text, uuid);
drop function issue_equipment(uuid, asset_collection, uuid, uuid, integer, uuid, text);
drop function create_employee(text, text);
drop function rebuild_equipment_register_from_assignments();
drop function sync_equipment_register();
drop function equipment_setting(text);
drop function resolve_employee(text, boolean, uuid);

drop view equipment_register_mismatches;
drop table equipment_issues;
drop type equipment_issue_status;

alter table onboarding_checklists
  drop column employee_id,
  drop column requested_laptop,
  drop column charger_required,
  drop column headset_required;
alter table offboarding_checklists drop column employee_id;
drop type requirement_answer;

drop view employee_possible_duplicates;
drop table employees;
drop function normalize_person_name(text);

alter table onboarding_checklists
  add constraint onboarding_checklists_assigned_asset_id_fkey
  foreign key (assigned_asset_id) references active_laptops_np (id) not valid;
