-- =========================================================================
-- Rollback for 20260901000028_employee_directory.sql
--
-- Removes the Active Employees directory: the HR fields and employment
-- status on employees, employee_history, the triggers on the checklists
-- and the directory functions; restores restore_backup exactly as
-- 20260901000027 left it. Employee ids, names, emails, checklists and the
-- equipment register are untouched. What 028 recorded is copied first, so
-- nothing is destroyed:
--   private.employee_directory_backup_028 (the new fields per employee)
--   private.employee_history_backup_028
-- Run BEFORE 20260901000027_down.sql, inside a transaction.
-- Not in supabase/migrations/ — never auto-applied.
-- =========================================================================
create schema if not exists private;
create table if not exists private.employee_directory_backup_028 as
  select now() as backed_up_at, id, first_name, last_name, department, job_title, hr_status, manager, start_date,
         employment_status::text as employment_status, reactivation_pending, status_changed_at, updated_at
  from employees limit 0;
insert into private.employee_directory_backup_028
  select now(), id, first_name, last_name, department, job_title, hr_status, manager, start_date,
         employment_status::text, reactivation_pending, status_changed_at, updated_at
  from employees
  where coalesce(first_name, last_name, department, job_title, hr_status, manager) is not null
     or start_date is not null or employment_status is not null or reactivation_pending;
create table if not exists private.employee_history_backup_028 as
  select now() as backed_up_at, id, employee_id, kind, from_status::text as from_status, to_status::text as to_status,
         changes, source, note, onboarding_id, offboarding_id, import_filename, actor_user_id, at
  from employee_history limit 0;
insert into private.employee_history_backup_028
  select now(), id, employee_id, kind, from_status::text, to_status::text, changes, source, note, onboarding_id,
         offboarding_id, import_filename, actor_user_id, at
  from employee_history;

drop trigger onboarding_checklists_sync_employment on onboarding_checklists;
drop trigger offboarding_checklists_sync_employment on offboarding_checklists;
drop function commit_employee_import(text, jsonb);
drop function set_employment_status(uuid, employment_status, text);
drop function save_employee(uuid, jsonb, employment_status);
drop function sync_employment_from_onboarding();
drop function sync_employment_from_offboarding();
drop function change_employment_status(uuid, employment_status, text, text, uuid, uuid, text);
drop function apply_employee_fields(uuid, jsonb, boolean);
drop function valid_work_email(text);
drop function employee_field_keys();
drop table employee_history;

-- 026 left employees without table-level write privileges revoked; put
-- the defaults back (RLS still has no write policy, so nothing changes).
grant insert, update, delete, truncate on employees to anon, authenticated;

drop index employees_email_key_unique;
drop index employees_employment_status_idx;
alter table employees
  drop column email_key,
  drop column first_name,
  drop column last_name,
  drop column department,
  drop column job_title,
  drop column hr_status,
  drop column manager,
  drop column start_date,
  drop column employment_status,
  drop column reactivation_pending,
  drop column status_changed_at,
  drop column updated_at;
drop type employment_status;

-- restore_backup exactly as in 20260901000027.
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
