-- =========================================================================
-- Offboarding laptop outcome: one choice instead of three checkboxes.
--
-- "Laptop received", "Laptop retained" and "Laptop decommissioned" are
-- mutually exclusive outcomes, plus "Not applicable" for an employee with
-- no laptop — which the three booleans can't express. Additive only:
--
--   * new column laptop_outcome (null = not chosen yet) and
--     outcome_needs_review (legacy record had more than one flag ticked);
--   * the three legacy boolean columns are KEPT and kept in sync by a
--     trigger, so anything still reading them (older app builds, backups,
--     reports) sees consistent values, and rolling back loses nothing but
--     "Not applicable" choices and review flags;
--   * existing rows are mapped conservatively: exactly one flag -> that
--     outcome; none -> not chosen; several -> not chosen + needs review
--     (never silently pick one). updated_at is left untouched.
--
-- Choosing an outcome is paperwork only: nothing here touches any asset —
-- collecting or decommissioning a device stays an explicit asset action.
-- Rollback: supabase/rollback/20260901000024_down.sql
-- =========================================================================

create type offboarding_laptop_outcome as enum ('received', 'retained', 'decommissioned', 'not_applicable');

alter table offboarding_checklists
  add column laptop_outcome offboarding_laptop_outcome,
  add column outcome_needs_review boolean not null default false;

comment on column offboarding_checklists.laptop_outcome is
  'The laptop disposition for this offboarding (null = not chosen yet). Authoritative; the legacy laptop_* booleans mirror it.';
comment on column offboarding_checklists.outcome_needs_review is
  'Set when legacy data had more than one laptop_* flag ticked; cleared once an outcome is chosen.';

-- ------------------------------------------------------------- backfill
-- Without the updated_at trigger, so mapped records keep their timestamps.
alter table offboarding_checklists disable trigger offboarding_checklists_set_updated_at;

update offboarding_checklists
set laptop_outcome = case
      when laptop_received then 'received'::offboarding_laptop_outcome
      when laptop_retained then 'retained'::offboarding_laptop_outcome
      else 'decommissioned'::offboarding_laptop_outcome
    end
where laptop_received::int + laptop_retained::int + laptop_decommissioned::int = 1;

update offboarding_checklists
set outcome_needs_review = true
where laptop_received::int + laptop_retained::int + laptop_decommissioned::int > 1;

alter table offboarding_checklists enable trigger offboarding_checklists_set_updated_at;

-- ----------------------------------------------------------------- sync
create function sync_offboarding_laptop_outcome()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_flags int := new.laptop_received::int + new.laptop_retained::int + new.laptop_decommissioned::int;
  v_flags_changed boolean := tg_op = 'UPDATE' and (
    new.laptop_received is distinct from old.laptop_received
    or new.laptop_retained is distinct from old.laptop_retained
    or new.laptop_decommissioned is distinct from old.laptop_decommissioned
  );
begin
  if (tg_op = 'INSERT' and new.laptop_outcome is null) or
     (v_flags_changed and new.laptop_outcome is not distinct from old.laptop_outcome) then
    -- Written via the legacy flags (older app build, pre-024 backup):
    -- derive the outcome the same conservative way as the backfill.
    if v_flags = 1 then
      new.laptop_outcome := case
        when new.laptop_received then 'received'::offboarding_laptop_outcome
        when new.laptop_retained then 'retained'::offboarding_laptop_outcome
        else 'decommissioned'::offboarding_laptop_outcome
      end;
      new.outcome_needs_review := false;
    elsif v_flags = 0 then
      if new.laptop_outcome is distinct from 'not_applicable' then
        new.laptop_outcome := null;
      end if;
      -- Keep a restored backup's review flag; a legacy edit that clears
      -- every flag resolves it.
      new.outcome_needs_review := tg_op = 'INSERT' and new.outcome_needs_review;
    else
      new.laptop_outcome := null;
      new.outcome_needs_review := true;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' or new.laptop_outcome is distinct from old.laptop_outcome then
    -- The outcome was chosen (or cleared): it wins, the flags follow, and
    -- an explicit choice resolves any earlier conflict.
    new.laptop_received := new.laptop_outcome is not distinct from 'received';
    new.laptop_retained := new.laptop_outcome is not distinct from 'retained';
    new.laptop_decommissioned := new.laptop_outcome is not distinct from 'decommissioned';
    new.outcome_needs_review := false;
  end if;
  return new;
end;
$$;

create trigger offboarding_sync_laptop_outcome
  before insert or update on offboarding_checklists
  for each row execute function sync_offboarding_laptop_outcome();

-- ------------------------------------------------------- backup/restore
-- Same as 20260901000020 except the offboarding insert, which now carries
-- the two new columns so "Not applicable" and review flags survive a restore.
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
