-- =========================================================================
-- Inventory integrity: serial-number uniqueness (M1), non-destructive Excel
-- imports (C4), and a verified restore (C5, server side).
--
-- M1 — one physical device per serial, across ALL serialized equipment
--   (Laptop Inventory, Active Laptops (NP), Monitors, Other Equipment).
--   Comparison key (normalize_serial): trim leading/trailing whitespace
--   (incl. tabs, newlines, non-breaking spaces), collapse any internal run
--   of whitespace to ONE space, upper-case. So "abc123", " ABC123 " and
--   "ABC123" are the same device; "ABC 123" and "ABC  123" are the same
--   device; "ABC123" and "ABC 123" are different. The serial as typed is
--   kept for display. A blank serial is rejected for new devices.
--   serial_keys holds one row per device (its id never changes, even when
--   it moves between Inventory and Active Laptops); a partial unique index
--   makes concurrent creates of the same serial impossible. Devices that
--   are ALREADY duplicates are kept as they are — never merged or deleted —
--   marked "grandfathered", listed in serial_duplicate_candidates for
--   review, and still fully usable; no NEW device can take their serial.
--
-- C4 — commit_asset_import never changes a device's status or assignment.
--   Matching is by normalized serial across all serialized tables (a laptop
--   in Active Laptops is found from a Laptop Inventory import). Existing
--   device: name/category/location are updated only when the cell is
--   non-empty and different; blank cells never clear anything; a status or
--   assignee that differs is REPORTED, not applied (those need a lifecycle
--   action); an unchanged row writes nothing (idempotent). New device: may
--   be created with an unassigned starting status; a row that would create
--   an assigned / provided / lost device is reported instead. Everything is
--   one transaction: any failure leaves every device untouched.
--
-- C5 — restore_backup verifies the restored row count of every table
--   against the counts the export recorded (when present) and rebuilds the
--   serial registry; any mismatch rolls the whole restore back.
--
-- Additive: no existing row is changed. Rollback:
-- supabase/rollback/20260901000027_down.sql
-- =========================================================================

create function normalize_serial(p_serial text)
returns text
language sql
immutable
set search_path = public
as $$
  select upper(regexp_replace(
    btrim(coalesce(p_serial, ''), ' ' || chr(9) || chr(10) || chr(13) || chr(160)),
    '[[:space:]' || chr(160) || ']+', ' ', 'g'));
$$;

-- ------------------------------------------------------- serial registry
create table serial_keys (
  asset_id uuid primary key,
  collection asset_collection not null,
  serial_key text not null,
  -- Already a duplicate when this migration ran (or restored as one):
  -- kept, reviewable, but no new device may take this serial.
  grandfathered boolean not null default false
);
create unique index serial_keys_one_device_per_serial on serial_keys (serial_key)
  where not grandfathered and serial_key <> '';
create index serial_keys_serial_key_idx on serial_keys (serial_key);

alter table serial_keys enable row level security;
create policy serial_keys_select_known on serial_keys for select using (is_known_user());
-- No write policies: maintained only by the triggers below.
revoke insert, update, delete, truncate on serial_keys from anon, authenticated;

comment on table serial_keys is
  'One row per serialized device: its normalized serial (normalize_serial). Enforces one device per serial across all serialized tables.';

create function rebuild_serial_keys()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from serial_keys;
  insert into serial_keys (asset_id, collection, serial_key, grandfathered)
  select id, collection, serial_key, serial_key = '' or count(*) over (partition by serial_key) > 1
  from (
    select id, 'serialized_assets'::asset_collection as collection, normalize_serial(serial) as serial_key from serialized_assets
    union all select id, 'active_laptops_np', normalize_serial(serial) from active_laptops_np
    union all select id, 'monitors', normalize_serial(serial) from monitors
    union all select id, 'other_equipment', normalize_serial(serial) from other_equipment
  ) d;
end;
$$;

select rebuild_serial_keys();

create function enforce_serial_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := normalize_serial(new.serial);
  v_mine serial_keys;
  v_other serial_keys;
begin
  -- restore_backup reloads everything, then rebuilds the registry.
  if nullif(current_setting('equipment.serial_check_disabled', true), '') = 'on' then
    return new;
  end if;

  select * into v_mine from serial_keys where asset_id = new.id;
  if v_mine.asset_id is not null and v_mine.serial_key = v_key then
    -- The same device (e.g. moving between Inventory and Active Laptops,
    -- which keeps its id): just follow it.
    if v_mine.collection::text <> tg_table_name then
      update serial_keys set collection = tg_table_name::asset_collection where asset_id = new.id;
    end if;
    return new;
  end if;

  if v_key = '' then
    raise exception 'A serial number is required' using errcode = 'check_violation';
  end if;
  select * into v_other from serial_keys where serial_key = v_key and asset_id <> new.id limit 1;
  if v_other.asset_id is not null then
    raise exception 'Serial number "%" already exists (as % in %) — each device needs its own serial',
      btrim(new.serial), v_key, replace(v_other.collection::text, '_', ' ')
      using errcode = 'unique_violation';
  end if;

  begin
    insert into serial_keys (asset_id, collection, serial_key)
    values (new.id, tg_table_name::asset_collection, v_key)
    on conflict (asset_id) do update set collection = excluded.collection, serial_key = excluded.serial_key, grandfathered = false;
  exception when unique_violation then
    -- Another transaction took this serial a moment ago.
    raise exception 'Serial number "%" already exists — each device needs its own serial', btrim(new.serial)
      using errcode = 'unique_violation';
  end;
  return new;
end;
$$;

create function release_serial_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A move inserts the device into its new table BEFORE deleting it from
  -- the old one, so the registry row already points at the new table here
  -- and is kept.
  delete from serial_keys where asset_id = old.id and collection::text = tg_table_name;
  return null;
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment'] loop
    execute format('create trigger %I before insert or update of serial on %I for each row execute function enforce_serial_key()',
      v_table || '_enforce_serial_key', v_table);
    execute format('create trigger %I after delete on %I for each row execute function release_serial_key()',
      v_table || '_release_serial_key', v_table);
  end loop;
end $$;

-- Existing duplicates, for review only — nothing acts on this.
create view serial_duplicate_candidates
  with (security_invoker = true) as
with devices as (
  select 'serialized_assets'::asset_collection as collection, id, serial, status, assigned_to from serialized_assets
  union all select 'active_laptops_np', id, serial, status, assigned_to from active_laptops_np
  union all select 'monitors', id, serial, status, assigned_to from monitors
  union all select 'other_equipment', id, serial, status, assigned_to from other_equipment
)
select normalize_serial(d.serial) as serial_key, d.collection, d.id as asset_id, d.serial, d.status, d.assigned_to,
       case when normalize_serial(d.serial) = '' then 'Blank serial' else 'Same serial as another device' end as reason
from devices d
where normalize_serial(d.serial) = ''
   or normalize_serial(d.serial) in (
     select normalize_serial(serial) from devices group by 1 having count(*) > 1
   );

revoke execute on function rebuild_serial_keys() from public, anon, authenticated;
revoke execute on function enforce_serial_key() from public, anon, authenticated;
revoke execute on function release_serial_key() from public, anon, authenticated;

-- ------------------------------------------------------------- imports
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
  v_actor uuid := auth.uid();
  v_role user_role;
  v_row jsonb;
  v_n int;
  v_serial text;
  v_key text;
  v_matches int;
  v_hit serial_keys;
  v_cur record;
  v_history text;
  v_name text;
  v_category text;
  v_location text;
  v_status text;
  v_assignee text;
  v_changes text[];
  v_new_id uuid;
  v_created int := 0;
  v_updated int := 0;
  v_unchanged int := 0;
  v_rejected int := 0;
  v_issues jsonb := '[]'::jsonb;
  v_laptops constant text[] := array['serialized_assets', 'active_laptops_np'];
begin
  select role into v_role from profiles where id = v_actor;
  if v_role is null or v_role not in ('admin', 'editor') then
    raise exception 'Not authorized to import';
  end if;
  -- Assignment changes made below (none should be) are marked as imports
  -- for the register's sync trigger (20260901000026).
  perform set_config('equipment.context', 'import', true);

  for v_row, v_n in select value, ordinality from jsonb_array_elements(p_rows) with ordinality
  loop
    v_serial := btrim(coalesce(v_row ->> 'serial', ''));
    v_key := normalize_serial(v_serial);
    v_name := nullif(btrim(coalesce(v_row ->> 'name', '')), '');
    v_category := nullif(btrim(coalesce(v_row ->> 'category', '')), '');
    v_location := nullif(btrim(coalesce(v_row ->> 'location', '')), '');
    v_status := nullif(lower(btrim(coalesce(v_row ->> 'status', ''))), '');
    v_assignee := nullif(btrim(coalesce(v_row ->> 'assigned_to', '')), '');

    if v_key = '' then
      v_rejected := v_rejected + 1;
      v_issues := v_issues || jsonb_build_object('row', v_n, 'serial', v_serial, 'kind', 'rejected', 'reason', 'Missing serial number');
      continue;
    end if;
    if v_status is not null and not (v_status = any (enum_range(null::asset_status)::text[])) then
      v_rejected := v_rejected + 1;
      v_issues := v_issues || jsonb_build_object('row', v_n, 'serial', v_serial, 'kind', 'rejected', 'reason', format('Invalid status "%s"', v_status));
      continue;
    end if;

    select count(*) into v_matches from serial_keys where serial_key = v_key;
    if v_matches > 1 then
      v_rejected := v_rejected + 1;
      v_issues := v_issues || jsonb_build_object('row', v_n, 'serial', v_serial, 'kind', 'rejected',
        'reason', 'More than one device already has this serial — resolve the duplicate first');
      continue;
    end if;
    select * into v_hit from serial_keys where serial_key = v_key;

    if v_hit.asset_id is not null then
      -- ------------------------------------------------ existing device
      if v_hit.collection::text <> p_collection::text
         and not (v_hit.collection::text = any (v_laptops) and p_collection::text = any (v_laptops)) then
        v_rejected := v_rejected + 1;
        v_issues := v_issues || jsonb_build_object('row', v_n, 'serial', v_serial, 'kind', 'rejected',
          'collection', v_hit.collection, 'asset_id', v_hit.asset_id,
          'reason', format('This serial already belongs to a device in %s', replace(v_hit.collection::text, '_', ' ')));
        continue;
      end if;

      execute format('select name, category, location, status::text as status, assigned_to from %I where id = $1', v_hit.collection)
        into v_cur using v_hit.asset_id;

      -- Ownership and lifecycle are never changed by an import: report.
      if v_status is not null and v_status <> v_cur.status then
        v_issues := v_issues || jsonb_build_object('row', v_n, 'serial', v_serial, 'kind', 'not_applied',
          'collection', v_hit.collection, 'asset_id', v_hit.asset_id, 'field', 'status',
          'current', v_cur.status, 'requested', v_status,
          'reason', 'Status changes need a lifecycle action on the device — not applied');
      end if;
      if v_assignee is not null and normalize_person_name(v_assignee) is distinct from normalize_person_name(v_cur.assigned_to) then
        v_issues := v_issues || jsonb_build_object('row', v_n, 'serial', v_serial, 'kind', 'not_applied',
          'collection', v_hit.collection, 'asset_id', v_hit.asset_id, 'field', 'assigned_to',
          'current', v_cur.assigned_to, 'requested', v_assignee,
          'reason', 'Assignment changes need Provide / Transfer / Collect on the device — not applied');
      end if;

      -- Metadata: only non-empty, different values.
      v_changes := array[]::text[];
      if v_name is not null and v_name is distinct from v_cur.name then
        v_changes := v_changes || format('name "%s" → "%s"', v_cur.name, v_name);
      else
        v_name := v_cur.name;
      end if;
      if v_category is not null and v_category is distinct from v_cur.category then
        v_changes := v_changes || format('category "%s" → "%s"', v_cur.category, v_category);
      else
        v_category := v_cur.category;
      end if;
      if v_location is not null and v_location is distinct from v_cur.location then
        v_changes := v_changes || format('location "%s" → "%s"', coalesce(v_cur.location, ''), v_location);
      else
        v_location := v_cur.location;
      end if;

      if cardinality(v_changes) = 0 then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;
      execute format('update %I set name = $1, category = $2, location = $3 where id = $4', v_hit.collection)
        using v_name, v_category, v_location, v_hit.asset_id;
      v_history := case v_hit.collection::text when 'serialized_assets' then 'serialized_asset_history' else v_hit.collection::text || '_history' end;
      execute format('insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)', v_history)
        using v_hit.asset_id, 'imported', format('Updated via import from %s: %s', p_filename, array_to_string(v_changes, '; ')), v_actor;
      v_updated := v_updated + 1;
    else
      -- ------------------------------------------------------ new device
      if v_name is null or v_category is null then
        v_rejected := v_rejected + 1;
        v_issues := v_issues || jsonb_build_object('row', v_n, 'serial', v_serial, 'kind', 'rejected', 'reason', 'Name and category are required for a new device');
        continue;
      end if;
      if v_assignee is not null or v_status in ('provided', 'retained', 'lost') then
        v_rejected := v_rejected + 1;
        v_issues := v_issues || jsonb_build_object('row', v_n, 'serial', v_serial, 'kind', 'rejected',
          'reason', 'A new device can''t be imported as assigned, Provided, Retained or Lost — import it without Status/Assigned to, then use Provide on the device');
        continue;
      end if;
      execute format('insert into %I (name, category, serial, status, location) values ($1, $2, $3, $4, $5) returning id', p_collection)
        into v_new_id using v_name, v_category, v_serial, coalesce(v_status, 'available')::asset_status, v_location;
      v_history := case p_collection::text when 'serialized_assets' then 'serialized_asset_history' else p_collection::text || '_history' end;
      execute format('insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)', v_history)
        using v_new_id, 'created', 'Imported from ' || p_filename, v_actor;
      v_created := v_created + 1;
    end if;
  end loop;

  insert into import_events
    (imported_by, target_collection, filename, rows_created, rows_updated, rows_errored, summary)
  values
    (v_actor, p_collection::text, p_filename, v_created, v_updated, v_rejected,
     jsonb_build_object('total', jsonb_array_length(p_rows), 'unchanged', v_unchanged, 'issues', v_issues));

  perform set_config('equipment.context', '', true);
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'unchanged', v_unchanged,
                            'rejected', v_rejected, 'issues', v_issues);
end;
$$;

-- ------------------------------------------------------- backup/restore
-- The 026 restore body is kept unchanged as restore_backup_load (callable
-- only from here). The new restore_backup wraps it: serial checks are off
-- while the load runs, the registry is rebuilt afterwards, and — when the
-- backup carries the row counts the export verified (key "_counts", added
-- by the app since this migration) — every table must contain exactly
-- that many rows, and the file itself must hold that many, or the whole
-- restore is rolled back. Older backups (no "_counts") restore as before.
alter function restore_backup(jsonb) rename to restore_backup_load;
revoke execute on function restore_backup_load(jsonb) from public, anon, authenticated;

create function restore_backup(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tables constant text[] := array[
    'serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment', 'bulk_items',
    'serialized_asset_history', 'active_laptops_np_history', 'monitors_history',
    'other_equipment_history', 'bulk_item_history', 'onboarding_checklists',
    'offboarding_checklists', 'import_events', 'employees', 'equipment_issues'];
  v_counts jsonb := p_payload -> '_counts';
  v_table text;
  v_expected bigint;
  v_actual bigint;
  v_result jsonb := '{}'::jsonb;
begin
  if not is_admin() then
    raise exception 'Only an admin can restore a backup';
  end if;

  if v_counts is not null then
    if jsonb_typeof(v_counts) <> 'object' then
      raise exception 'Backup file is damaged: "_counts" is not an object';
    end if;
    for v_table in select jsonb_object_keys(v_counts) loop
      if not (v_table = any (v_tables)) then
        raise exception 'Backup file lists an unknown table "%"', v_table;
      end if;
    end loop;
    foreach v_table in array v_tables loop
      if v_counts ? v_table then
        v_expected := (v_counts ->> v_table)::bigint;
        v_actual := coalesce(jsonb_array_length(p_payload -> v_table), -1);
        if v_actual <> v_expected then
          raise exception 'Backup file is incomplete: % has % rows but the export recorded %',
            v_table, greatest(v_actual, 0), v_expected;
        end if;
      end if;
    end loop;
  end if;

  perform set_config('equipment.serial_check_disabled', 'on', true);
  perform restore_backup_load(p_payload);
  perform set_config('equipment.serial_check_disabled', '', true);
  perform rebuild_serial_keys();

  foreach v_table in array v_tables loop
    execute format('select count(*) from %I', v_table) into v_actual;
    v_result := v_result || jsonb_build_object(v_table, v_actual);
    if v_counts ? v_table and v_actual <> (v_counts ->> v_table)::bigint then
      raise exception 'Restore incomplete: % has % rows after restore, expected % — nothing was changed',
        v_table, v_actual, v_counts ->> v_table;
    end if;
  end loop;

  return jsonb_build_object('counts', v_result,
    'duplicate_serials', (select count(*) from serial_keys where grandfathered),
    'register_mismatches', (select count(*) from equipment_register_mismatches));
end;
$$;

revoke execute on function restore_backup(jsonb) from public, anon;
grant execute on function restore_backup(jsonb) to authenticated;
