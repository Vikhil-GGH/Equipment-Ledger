-- =========================================================================
-- Active Employees directory, on the existing employee identity
-- (employees, 20260901000026) — no second employee table.
--
-- employees gains HR fields (first/last name, department, job title, the
-- "Employee Status" text as imported, manager, start date), work email
-- (the existing `email`, now unique once normalized), and an employment
-- status:
--   employment_status  null      = not in the directory yet (every
--                                  existing row: nothing is guessed)
--                      'active'  = shown in Active Employees
--                      'inactive'= offboarded / no longer employed (kept,
--                                  with all history and equipment links)
--   reactivation_pending          an offboarded employee completed a new
--                                  onboarding — needs explicit Reactivate.
--
-- Automatic changes (triggers on the checklists, which editors update):
--   onboarding becomes complete (all 4 steps) -> null: Active;
--     inactive: stays inactive, flagged reactivation_pending.
--   offboarding becomes complete (access removed + laptop outcome) ->
--     Inactive. Equipment is never touched: pending returns stay pending.
-- Starting a checklist changes nothing. Every change is recorded in
-- employee_history (who, when, why, old and new values).
--
-- Writes go through save_employee / set_employment_status /
-- commit_employee_import (editor or admin). Backup/restore carry the new
-- fields and the history; restore never fires the automatic changes.
--
-- Additive: no existing row or value is changed. Rollback:
-- supabase/rollback/20260901000028_down.sql
-- =========================================================================

create type employment_status as enum ('active', 'inactive');

alter table employees
  add column first_name text,
  add column last_name text,
  add column department text,
  add column job_title text,
  -- "Employee Status" exactly as it came from HR / the Excel file.
  add column hr_status text,
  add column manager text,
  add column start_date date,
  add column employment_status employment_status,
  add column reactivation_pending boolean not null default false,
  add column status_changed_at timestamptz,
  add column updated_at timestamptz,
  add column email_key text generated always as (nullif(lower(btrim(email)), '')) stored;

-- One employee per work email (case and surrounding spaces ignored).
create unique index employees_email_key_unique on employees (email_key) where email_key is not null;
create index employees_employment_status_idx on employees (employment_status);

comment on column employees.employment_status is
  'null = not in the Active Employees directory; active; inactive (offboarded). Independent of equipment returns.';

-- ------------------------------------------------------------- history
create table employee_history (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id),
  -- 'status' (employment status changed), 'details' (fields edited),
  -- 'created', 'reactivation_pending'
  kind text not null check (kind in ('created', 'status', 'details', 'reactivation_pending')),
  from_status employment_status,
  to_status employment_status,
  -- Old and new values of edited fields: {"department": ["IT", "Finance"], ...}
  changes jsonb,
  -- 'manual' | 'import' | 'onboarding_completed' | 'offboarding_completed'
  source text not null,
  note text,
  -- Kept as plain ids so history outlives a deleted checklist.
  onboarding_id uuid,
  offboarding_id uuid,
  import_filename text,
  actor_user_id uuid references profiles (id),
  at timestamptz not null default clock_timestamp()
);
create index employee_history_employee_idx on employee_history (employee_id, at);

alter table employee_history enable row level security;
create policy employee_history_select_known on employee_history for select using (is_known_user());
revoke insert, update, delete, truncate on employee_history from anon, authenticated;
revoke insert, update, delete, truncate on employees from anon, authenticated;

comment on table employee_history is
  'Audit trail of employment status and employee detail changes. Written only by the database.';

-- ------------------------------------------------------------ helpers
create function employee_field_keys()
returns text[]
language sql
immutable
as $$
  select array['first_name', 'last_name', 'department', 'job_title', 'hr_status', 'manager', 'start_date', 'email'];
$$;

create function valid_work_email(p text)
returns boolean
language sql
immutable
as $$
  select p is null or btrim(p) ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$';
$$;

-- Applies the given fields to an employee and returns {"field": [old, new]}
-- for what actually changed. p_clear_blank = false: empty/missing values
-- never clear anything (imports); true: a present-but-empty value clears
-- the field (the edit form, where the user sees and empties it).
create function apply_employee_fields(p_id uuid, p_fields jsonb, p_clear_blank boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_key text;
  v_new text;
  v_changes jsonb := '{}'::jsonb;
begin
  select to_jsonb(e) into v_old from employees e where e.id = p_id for update;
  if v_old is null then
    raise exception 'Employee not found';
  end if;
  foreach v_key in array employee_field_keys() loop
    if not (p_fields ? v_key) then
      continue;
    end if;
    v_new := nullif(btrim(coalesce(p_fields ->> v_key, '')), '');
    if v_new is null and not p_clear_blank then
      continue;
    end if;
    if v_key = 'email' and not valid_work_email(v_new) then
      raise exception 'Invalid work email "%"', v_new using errcode = 'check_violation';
    end if;
    if v_key = 'start_date' and v_new is not null then
      v_new := v_new::date::text; -- validates
    end if;
    if v_new is distinct from (v_old ->> v_key) then
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_array(v_old ->> v_key, v_new));
    end if;
  end loop;
  if v_changes = '{}'::jsonb then
    return v_changes;
  end if;
  begin
    update employees set
      first_name = case when v_changes ? 'first_name' then v_changes -> 'first_name' ->> 1 else first_name end,
      last_name = case when v_changes ? 'last_name' then v_changes -> 'last_name' ->> 1 else last_name end,
      department = case when v_changes ? 'department' then v_changes -> 'department' ->> 1 else department end,
      job_title = case when v_changes ? 'job_title' then v_changes -> 'job_title' ->> 1 else job_title end,
      hr_status = case when v_changes ? 'hr_status' then v_changes -> 'hr_status' ->> 1 else hr_status end,
      manager = case when v_changes ? 'manager' then v_changes -> 'manager' ->> 1 else manager end,
      start_date = case when v_changes ? 'start_date' then (v_changes -> 'start_date' ->> 1)::date else start_date end,
      email = case when v_changes ? 'email' then v_changes -> 'email' ->> 1 else email end,
      updated_at = now()
    where id = p_id;
  exception when unique_violation then
    raise exception 'Another employee already has the work email "%"', v_changes -> 'email' ->> 1 using errcode = 'unique_violation';
  end;
  return v_changes;
end;
$$;

-- Changes employment status and records it. Internal (no role check).
create function change_employment_status(
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

-- ----------------------------------------------- checklist completion
create function sync_employment_from_onboarding()
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

create function sync_employment_from_offboarding()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_was boolean := old.removed_access and old.laptop_outcome is not null;
  v_is boolean := new.removed_access and new.laptop_outcome is not null;
begin
  if equipment_setting('equipment.sync_disabled') = 'on' or new.employee_id is null or not v_is then
    return null;
  end if;
  if v_was and old.employee_id is not distinct from new.employee_id then
    return null;
  end if;
  -- Employment only. Equipment still with the employee stays pending return.
  perform change_employment_status(new.employee_id, 'inactive', 'offboarding_completed', null, null, new.id);
  update employees set reactivation_pending = false where id = new.employee_id and reactivation_pending;
  return null;
end;
$$;

create trigger onboarding_checklists_sync_employment
  after update on onboarding_checklists
  for each row execute function sync_employment_from_onboarding();
create trigger offboarding_checklists_sync_employment
  after update on offboarding_checklists
  for each row execute function sync_employment_from_offboarding();

-- ------------------------------------------------------------ the API
-- Add (p_employee_id null) or edit an employee. The edit form sends every
-- field it shows, so an emptied field clears it. A new employee from the
-- directory starts Active unless p_status says otherwise.
create function save_employee(p_employee_id uuid, p_fields jsonb, p_status employment_status default 'active')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := p_employee_id;
  v_first text := nullif(btrim(coalesce(p_fields ->> 'first_name', '')), '');
  v_last text := nullif(btrim(coalesce(p_fields ->> 'last_name', '')), '');
  v_changes jsonb;
begin
  if not is_editor_or_admin() then
    raise exception 'Not authorized to edit employees';
  end if;
  if v_id is null then
    if v_first is null or v_last is null then
      raise exception 'First and last name are required';
    end if;
    insert into employees (full_name, created_by) values (v_first || ' ' || v_last, auth.uid()) returning id into v_id;
    perform apply_employee_fields(v_id, p_fields, false);
    update employees set employment_status = p_status, status_changed_at = case when p_status is null then null else now() end, updated_at = now() where id = v_id;
    insert into employee_history (employee_id, kind, to_status, source, actor_user_id)
    values (v_id, 'created', p_status, 'manual', auth.uid());
    return v_id;
  end if;
  v_changes := apply_employee_fields(v_id, p_fields, true);
  if v_changes <> '{}'::jsonb then
    insert into employee_history (employee_id, kind, changes, source, actor_user_id)
    values (v_id, 'details', v_changes, 'manual', auth.uid());
  end if;
  return v_id;
end;
$$;

-- Explicit status change (incl. Reactivate a rehire, or add an existing
-- employee record to the directory). Never touches equipment.
create function set_employment_status(p_employee_id uuid, p_status employment_status, p_note text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_editor_or_admin() then
    raise exception 'Not authorized to change employment status';
  end if;
  if p_status is null then
    raise exception 'Choose Active or Inactive';
  end if;
  return change_employment_status(p_employee_id, p_status, 'manual', nullif(btrim(coalesce(p_note, '')), ''));
end;
$$;

-- Commits an import the user reviewed. Each row:
--   {"row": n, "action": "create" | "update", "employee_id": uuid (update),
--    "fields": {first_name, last_name, department, job_title, hr_status,
--               manager, start_date, email},
--    "status": "active" | "inactive" (create: initial status; update:
--               only when the user approved that status change)}
-- Blank values never clear anything. A row whose email belongs to a
-- different employee is reported, not applied — so the same file can be
-- re-imported without creating anyone twice. One transaction.
create function commit_employee_import(p_filename text, p_rows jsonb)
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
      v_status := coalesce(v_status, 'active');
      update employees set employment_status = v_status, status_changed_at = now(), updated_at = now() where id = v_id;
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

revoke execute on function apply_employee_fields(uuid, jsonb, boolean) from public, anon, authenticated;
revoke execute on function change_employment_status(uuid, employment_status, text, text, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function sync_employment_from_onboarding() from public, anon, authenticated;
revoke execute on function sync_employment_from_offboarding() from public, anon, authenticated;
revoke execute on function save_employee(uuid, jsonb, employment_status) from public, anon;
revoke execute on function set_employment_status(uuid, employment_status, text) from public, anon;
revoke execute on function commit_employee_import(text, jsonb) from public, anon;
grant execute on function save_employee(uuid, jsonb, employment_status) to authenticated;
grant execute on function set_employment_status(uuid, employment_status, text) to authenticated;
grant execute on function commit_employee_import(text, jsonb) to authenticated;

-- ------------------------------------------------------- backup/restore
-- As 20260901000027, plus the directory fields on employees and the
-- employee_history table. Older backups (no such keys) restore as before:
-- the new fields stay empty and there is no history.
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
