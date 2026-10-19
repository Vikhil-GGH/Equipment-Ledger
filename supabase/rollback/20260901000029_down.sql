-- =========================================================================
-- Rollback for 20260901000029_activation_and_bulk_import.sql
--
-- Restores change_employment_status, sync_employment_from_onboarding,
-- commit_employee_import and restore_backup exactly as 20260901000028 left
-- them, commit_bulk_import exactly as 20260901000014 (H4 returns) and
-- create_bulk_item exactly as 20260901000012.
-- What 029 recorded is copied first, so nothing is lost:
--   private.employee_decisions_backup_029 (status_decision_required flags)
--   private.employee_history_decisions_backup_029 ('decision_required'
--     entries, which the restored 028 check constraint does not allow)
--   private.bulk_import_receipts_backup_029
-- Run BEFORE 20260901000028_down.sql, inside a transaction.
-- Not in supabase/migrations/ — never auto-applied.
-- =========================================================================
create schema if not exists private;
create table if not exists private.employee_decisions_backup_029 as
  select now() as backed_up_at, id as employee_id from employees limit 0;
insert into private.employee_decisions_backup_029 select now(), id from employees where status_decision_required;
create table if not exists private.employee_history_decisions_backup_029 as
  select now() as backed_up_at, h.* from employee_history h limit 0;
insert into private.employee_history_decisions_backup_029 select now(), h.* from employee_history h where kind = 'decision_required';
create table if not exists private.bulk_import_receipts_backup_029 as
  select now() as backed_up_at, r.* from bulk_import_receipts r limit 0;
insert into private.bulk_import_receipts_backup_029 select now(), r.* from bulk_import_receipts r;

-- Functions as in 20260901000028 / 20260901000014.
create or replace function change_employment_status(
  p_id uuid,
  p_status employment_status,
  p_source text,
  p_note text default null,
  p_onboarding_id uuid default null,
  p_offboarding_id uuid default null,
  p_import_filename text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from employment_status;
begin
  select employment_status into v_from from employees where id = p_id for update;
  if not found then
    raise exception 'Employee not found';
  end if;
  if v_from is not distinct from p_status then
    return false;
  end if;
  update employees
     set employment_status = p_status, status_changed_at = now(), updated_at = now(),
         reactivation_pending = case when p_status = 'active' then false else reactivation_pending end
   where id = p_id;
  insert into employee_history (employee_id, kind, from_status, to_status, source, note, onboarding_id, offboarding_id, import_filename, actor_user_id)
  values (p_id, 'status', v_from, p_status, p_source, p_note, p_onboarding_id, p_offboarding_id, p_import_filename,
          (select id from profiles where id = auth.uid()));
  return true;
end;
$$;

create or replace function sync_employment_from_onboarding()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was boolean := old.identity_created and old.equipment_assigned and old.required_access_provided and old.onboarding_successful;
  v_is boolean := new.identity_created and new.equipment_assigned and new.required_access_provided and new.onboarding_successful;
  v_status employment_status;
begin
  if equipment_setting('equipment.sync_disabled') = 'on' or new.employee_id is null or not v_is then
    return null;
  end if;
  -- Just completed, or an already-complete record just linked to its employee.
  if v_was and old.employee_id is not distinct from new.employee_id then
    return null;
  end if;
  select employment_status into v_status from employees where id = new.employee_id for update;
  if v_status is null then
    perform change_employment_status(new.employee_id, 'active', 'onboarding_completed', null, new.id);
  elsif v_status = 'inactive' then
    -- A rehire: never reactivated silently.
    update employees set reactivation_pending = true, updated_at = now() where id = new.employee_id and not reactivation_pending;
    if found then
      insert into employee_history (employee_id, kind, from_status, to_status, source, note, onboarding_id, actor_user_id)
      values (new.employee_id, 'reactivation_pending', 'inactive', 'inactive', 'onboarding_completed',
              'Onboarding completed for an offboarded employee — reactivate explicitly', new.id,
              (select id from profiles where id = auth.uid()));
    end if;
  end if;
  return null;
end;
$$;

create or replace function commit_employee_import(p_filename text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_fields jsonb;
  v_action text;
  v_id uuid;
  v_email text;
  v_owner uuid;
  v_first text;
  v_last text;
  v_status employment_status;
  v_changes jsonb;
  v_created int := 0;
  v_updated int := 0;
  v_unchanged int := 0;
  v_status_changes int := 0;
  v_conflicts jsonb := '[]'::jsonb;
begin
  if not is_editor_or_admin() then
    raise exception 'Not authorized to import employees';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_action := v_row ->> 'action';
    v_fields := coalesce(v_row -> 'fields', '{}'::jsonb);
    v_email := nullif(lower(btrim(coalesce(v_fields ->> 'email', ''))), '');
    v_status := nullif(v_row ->> 'status', '')::employment_status;
    if not valid_work_email(v_email) then
      v_conflicts := v_conflicts || jsonb_build_object('row', v_row -> 'row', 'reason', format('Invalid work email "%s"', v_email));
      continue;
    end if;
    select id into v_owner from employees where email_key = v_email;

    if v_action = 'create' then
      v_first := nullif(btrim(coalesce(v_fields ->> 'first_name', '')), '');
      v_last := nullif(btrim(coalesce(v_fields ->> 'last_name', '')), '');
      if v_first is null or v_last is null then
        v_conflicts := v_conflicts || jsonb_build_object('row', v_row -> 'row', 'reason', 'First and last name are required');
        continue;
      end if;
      if v_owner is not null then
        v_conflicts := v_conflicts || jsonb_build_object('row', v_row -> 'row', 'employee_id', v_owner,
          'reason', 'An employee with this work email already exists — not created again');
        continue;
      end if;
      insert into employees (full_name, created_by) values (v_first || ' ' || v_last, auth.uid()) returning id into v_id;
      perform apply_employee_fields(v_id, v_fields, false);
      -- No status given (e.g. an unrecognised Employee Status): added as
      -- "Not in directory" — employment status is never guessed.
      update employees set employment_status = v_status, status_changed_at = case when v_status is null then null else now() end,
             updated_at = now() where id = v_id;
      insert into employee_history (employee_id, kind, to_status, source, import_filename, actor_user_id)
      values (v_id, 'created', v_status, 'import', p_filename, auth.uid());
      v_created := v_created + 1;

    elsif v_action = 'update' then
      v_id := (v_row ->> 'employee_id')::uuid;
      if v_id is null or not exists (select 1 from employees where id = v_id) then
        v_conflicts := v_conflicts || jsonb_build_object('row', v_row -> 'row', 'reason', 'Employee to update not found');
        continue;
      end if;
      if v_owner is not null and v_owner <> v_id then
        v_conflicts := v_conflicts || jsonb_build_object('row', v_row -> 'row', 'employee_id', v_id,
          'reason', 'This work email belongs to a different employee — not applied');
        continue;
      end if;
      v_changes := apply_employee_fields(v_id, v_fields, false);
      if v_changes <> '{}'::jsonb then
        insert into employee_history (employee_id, kind, changes, source, import_filename, actor_user_id)
        values (v_id, 'details', v_changes, 'import', p_filename, auth.uid());
      end if;
      if v_status is not null and change_employment_status(v_id, v_status, 'import', 'Approved in the import preview', null, null, p_filename) then
        v_status_changes := v_status_changes + 1;
      elsif v_changes = '{}'::jsonb then
        v_unchanged := v_unchanged + 1;
      end if;
      if v_changes <> '{}'::jsonb then
        v_updated := v_updated + 1;
      end if;
    else
      v_conflicts := v_conflicts || jsonb_build_object('row', v_row -> 'row', 'reason', 'Unknown action');
    end if;
  end loop;

  insert into import_events (imported_by, target_collection, filename, rows_created, rows_updated, rows_errored, summary)
  values (auth.uid(), 'employees', p_filename, v_created, v_updated, jsonb_array_length(v_conflicts),
          jsonb_build_object('total', jsonb_array_length(p_rows), 'unchanged', v_unchanged, 'status_changes', v_status_changes, 'conflicts', v_conflicts));
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'unchanged', v_unchanged,
                            'status_changes', v_status_changes, 'conflicts', v_conflicts);
end;
$$;

create or replace function restore_backup(p_payload jsonb)
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
    'offboarding_checklists', 'import_events', 'employees', 'equipment_issues', 'employee_history'];
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
  -- History references employees, which the loader deletes and reloads.
  delete from employee_history;
  perform restore_backup_load(p_payload);
  perform set_config('equipment.sync_disabled', 'on', true);

  update employees e set
    first_name = t.first_name, last_name = t.last_name, department = t.department, job_title = t.job_title,
    hr_status = t.hr_status, manager = t.manager, start_date = t.start_date, employment_status = t.employment_status,
    reactivation_pending = coalesce(t.reactivation_pending, false), status_changed_at = t.status_changed_at,
    updated_at = t.updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'employees', '[]'::jsonb))
    as t(id uuid, first_name text, last_name text, department text, job_title text, hr_status text, manager text,
         start_date date, employment_status employment_status, reactivation_pending boolean,
         status_changed_at timestamptz, updated_at timestamptz)
  where e.id = t.id;

  insert into employee_history
    (id, employee_id, kind, from_status, to_status, changes, source, note, onboarding_id, offboarding_id,
     import_filename, actor_user_id, at)
  select t.id, t.employee_id, t.kind, t.from_status, t.to_status, t.changes, t.source, t.note, t.onboarding_id,
         t.offboarding_id, t.import_filename, p.id, t.at
  from jsonb_to_recordset(coalesce(p_payload -> 'employee_history', '[]'::jsonb))
    as t(id uuid, employee_id uuid, kind text, from_status employment_status, to_status employment_status,
         changes jsonb, source text, note text, onboarding_id uuid, offboarding_id uuid, import_filename text,
         actor_user_id uuid, at timestamptz)
  left join profiles p on p.id = t.actor_user_id;

  perform set_config('equipment.sync_disabled', '', true);
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

drop function commit_bulk_import(text, jsonb, boolean);
create function commit_bulk_import(
  p_filename text,
  p_rows jsonb -- [{name, category, location, quantity}]
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
  v_id uuid;
  v_qty integer;
  v_created int := 0;
  v_updated int := 0;
begin
  select role into v_role from profiles where id = v_actor;
  if v_role is null or v_role not in ('admin', 'editor') then
    raise exception 'Not authorized to import';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_qty := coalesce(nullif(v_row ->> 'quantity', '')::integer, 0);

    select id into v_id
      from bulk_items
      where lower(name) = lower(v_row ->> 'name') and lower(category) = lower(v_row ->> 'category')
      limit 1;

    if v_id is null then
      insert into bulk_items (name, category, location, available)
      values (v_row ->> 'name', v_row ->> 'category', nullif(v_row ->> 'location', ''), v_qty)
      returning id into v_id;

      insert into bulk_item_history (item_id, action, detail, quantity, actor_user_id)
      values (v_id, 'created', 'Imported from ' || p_filename, v_qty, v_actor);

      v_created := v_created + 1;
    else
      update bulk_items set available = available + v_qty where id = v_id;

      insert into bulk_item_history (item_id, action, detail, quantity, actor_user_id)
      values (v_id, 'receive_stock', 'Received via import from ' || p_filename, v_qty, v_actor);

      v_updated := v_updated + 1;
    end if;
  end loop;

  insert into import_events
    (imported_by, target_collection, filename, rows_created, rows_updated, rows_errored, summary)
  values
    (v_actor, 'bulk_items', p_filename, v_created, v_updated, 0, jsonb_build_object('total', v_created + v_updated));

  return jsonb_build_object('created', v_created, 'updated', v_updated);
end;
$$;

grant execute on function commit_bulk_import(text, jsonb) to public, anon, authenticated;

drop table bulk_import_receipts;
-- create_bulk_item exactly as in 20260901000012.
create or replace function create_bulk_item(
  p_name text,
  p_category text,
  p_location text default null,
  p_initial_quantity integer default 0
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_role user_role;
  v_id uuid;
  v_qty integer := coalesce(p_initial_quantity, 0);
begin
  select role into v_role from profiles where id = v_actor;
  if v_role is null or v_role not in ('admin', 'editor') then
    raise exception 'Not authorized to add bulk stock items';
  end if;
  if v_qty < 0 then
    raise exception 'Initial quantity cannot be negative';
  end if;

  insert into bulk_items (name, category, location, available)
  values (p_name, p_category, p_location, v_qty)
  returning id into v_id;

  insert into bulk_item_history (item_id, action, detail, quantity, actor_user_id)
  values (v_id, 'created', 'Added to bulk stock', v_qty, v_actor);

  return v_id;
end;
$$;

drop index bulk_items_one_per_name_category;
drop function bulk_item_key(text);

delete from employee_history where kind = 'decision_required';
alter table employee_history drop constraint employee_history_kind_check;
alter table employee_history add constraint employee_history_kind_check
  check (kind in ('created', 'status', 'details', 'reactivation_pending'));
alter table employees drop column status_decision_required;
drop function hr_status_class(text);
