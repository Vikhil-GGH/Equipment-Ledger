-- =========================================================================
-- Employment activation safeguards (Active Employees) and idempotent
-- Bulk Stock imports (audit H4).
--
-- 1. Onboarding completion activates an employee only when that is clear:
--    their imported "Employee Status" is a recognised Active value, or they
--    have no imported status at all and no pending decision (a genuine new
--    hire). A recognised Inactive value or an unrecognised one (e.g. "Leave
--    of Absence") is WITHHELD: employment status stays as it is,
--    status_decision_required is set and an employee_history entry says
--    why. Equipment and the checklist are untouched. Any explicit status
--    (set_employment_status, or an approved import row) settles the
--    decision. Rows imported without a usable status are flagged at import,
--    so they are not mistaken for genuine new hires.
--    hr_status_class() is the database copy of
--    src/features/employees/employeeStatusMapping.ts (tests keep them equal).
--
-- 2. commit_bulk_import: a Bulk Stock import is a DELIVERY — "Quantity
--    received" is added to Available — never a stock total. Each import's
--    content (normalised item names, categories and quantities; not the
--    file name or row order) is recorded in bulk_import_receipts. The same
--    content again adds nothing and reports the earlier import, unless
--    p_confirm_repeat says it is a genuinely new delivery. Imports of the
--    same content are serialised with an advisory lock, and one bulk item
--    per normalised name + category is enforced, so concurrent imports
--    cannot double-count or create twins. A blank/0 quantity changes
--    nothing (no "received 0" history), and an item listed twice in one
--    file is rejected.
--
-- Additive: no existing row or value changes. Rollback:
-- supabase/rollback/20260901000029_down.sql
-- =========================================================================

-- ------------------------------------------------ employment safeguards
create function hr_status_class(p_text text)
returns text
language sql
immutable
as $$
  select case
    when nullif(btrim(coalesce(p_text, '')), '') is null then 'blank'
    when lower(regexp_replace(btrim(p_text), '\s+', ' ', 'g')) = 'active' then 'active'
    when lower(regexp_replace(btrim(p_text), '\s+', ' ', 'g')) in
      ('inactive', 'terminated', 'offboarded', 'separated', 'resigned', 'retired', 'former employee') then 'inactive'
    else 'review'
  end;
$$;

alter table employees add column status_decision_required boolean not null default false;
comment on column employees.status_decision_required is
  'An explicit Active/Inactive decision is needed (imported status unclear, or onboarding completed with an unclear status). Cleared by any explicit status.';

alter table employee_history drop constraint employee_history_kind_check;
alter table employee_history add constraint employee_history_kind_check
  check (kind in ('created', 'status', 'details', 'reactivation_pending', 'decision_required'));

-- Re-defined with the safeguards above (otherwise as in 20260901000028).
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
         reactivation_pending = case when p_status = 'active' then false else reactivation_pending end,
         -- Any explicit status settles a pending decision.
         status_decision_required = false
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
  v_hr text;
  v_decision boolean;
begin
  if equipment_setting('equipment.sync_disabled') = 'on' or new.employee_id is null or not v_is then
    return null;
  end if;
  -- Just completed, or an already-complete record just linked to its employee.
  if v_was and old.employee_id is not distinct from new.employee_id then
    return null;
  end if;
  select employment_status, hr_status, status_decision_required into v_status, v_hr, v_decision
    from employees where id = new.employee_id for update;
  if v_status is null then
    -- Activate only a recognised Active status, or a genuine new hire (no
    -- imported status and no pending decision). Anything else is withheld
    -- and flagged; equipment and the checklist are untouched.
    if hr_status_class(v_hr) = 'active' or (hr_status_class(v_hr) = 'blank' and not v_decision) then
      perform change_employment_status(new.employee_id, 'active', 'onboarding_completed', null, new.id);
    elsif not v_decision or not exists (
      select 1 from employee_history where employee_id = new.employee_id and kind = 'decision_required' and onboarding_id = new.id
    ) then
      update employees set status_decision_required = true, updated_at = now() where id = new.employee_id;
      insert into employee_history (employee_id, kind, from_status, to_status, source, note, onboarding_id, actor_user_id)
      values (new.employee_id, 'decision_required', null, null, 'onboarding_completed',
              format('Onboarding completed, but Employee Status "%s" does not say Active — choose Active or Inactive explicitly', coalesce(v_hr, '')),
              new.id, (select id from profiles where id = auth.uid()));
    end if;
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
             -- Imported without a usable status: needs an explicit decision
             -- (onboarding completion won't activate them on its own).
             status_decision_required = v_status is null,
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
      -- Still not in the directory, with an imported status that doesn't
      -- settle it: flag for an explicit decision.
      update employees set status_decision_required = true
       where id = v_id and employment_status is null and hr_status_class(hr_status) <> 'blank' and not status_decision_required;
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


-- ----------------------------------------------------------- bulk stock
create function bulk_item_key(p_text text)
returns text
language sql
immutable
as $$
  select lower(regexp_replace(btrim(coalesce(p_text, '')), '\s+', ' ', 'g'));
$$;

-- One item per name + category (case and spacing ignored). Staging had no
-- such duplicates when this was written; on a database that does, this
-- fails loudly instead of merging anything.
create unique index bulk_items_one_per_name_category on bulk_items (bulk_item_key(name), bulk_item_key(category));

create table bulk_import_receipts (
  id uuid primary key default gen_random_uuid(),
  content_hash text not null,
  filename text not null,
  import_event_id uuid,          -- plain id, so restore order doesn't matter
  repeat_of uuid,                -- set when confirmed as a new delivery of identical content
  imported_by uuid references profiles (id),
  imported_at timestamptz not null default clock_timestamp()
);
create index bulk_import_receipts_hash_idx on bulk_import_receipts (content_hash, imported_at);
alter table bulk_import_receipts enable row level security;
create policy bulk_import_receipts_select_known on bulk_import_receipts for select using (is_known_user());
revoke insert, update, delete, truncate on bulk_import_receipts from anon, authenticated;

comment on table bulk_import_receipts is
  'One row per committed Bulk Stock import: what it contained (content_hash), so the same delivery is not added twice.';

drop function commit_bulk_import(text, jsonb);

create function commit_bulk_import(
  p_filename text,
  p_rows jsonb, -- [{name, category, location, quantity}]
  p_confirm_repeat boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_role user_role;
  v_row record;
  v_id uuid;
  v_hash text;
  v_dupe text;
  v_prev bulk_import_receipts;
  v_event uuid;
  v_created int := 0;
  v_updated int := 0;
  v_unchanged int := 0;
begin
  select role into v_role from profiles where id = v_actor;
  if v_role is null or v_role not in ('admin', 'editor') then
    raise exception 'Not authorized to import';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Nothing to import';
  end if;

  drop table if exists pg_temp.bulk_import_rows;
  create temporary table bulk_import_rows on commit drop as
  select e.ord, btrim(coalesce(e.r ->> 'name', '')) as name, btrim(coalesce(e.r ->> 'category', '')) as category,
         nullif(btrim(coalesce(e.r ->> 'location', '')), '') as location,
         nullif(btrim(coalesce(e.r ->> 'quantity', '')), '') as qty_text
  from jsonb_array_elements(p_rows) with ordinality as e(r, ord);

  if exists (select 1 from bulk_import_rows where name = '' or category = '') then
    raise exception 'Every row needs a name and a category';
  end if;
  if exists (select 1 from bulk_import_rows where qty_text is not null and qty_text !~ '^[0-9]+$') then
    raise exception 'Quantities must be whole numbers of 0 or more';
  end if;
  select string_agg(format('"%s" (%s)', n, c), ', ') into v_dupe
  from (select min(name) as n, min(category) as c from bulk_import_rows
        group by bulk_item_key(name), bulk_item_key(category) having count(*) > 1) d;
  if v_dupe is not null then
    raise exception 'The file lists the same item more than once: % — combine those rows into one', v_dupe;
  end if;

  -- What this delivery contains, independent of file name, row order,
  -- capitalisation and spacing.
  select md5(string_agg(bulk_item_key(name) || '|' || bulk_item_key(category) || '|' || coalesce(qty_text::int, 0)::text, E'\n'
                        order by bulk_item_key(name), bulk_item_key(category)))
    into v_hash from bulk_import_rows;
  -- Imports of the same content run one after the other, never together.
  perform pg_advisory_xact_lock(hashtext('commit_bulk_import'), hashtext(v_hash));
  select * into v_prev from bulk_import_receipts where content_hash = v_hash order by imported_at desc limit 1;
  if v_prev.id is not null and not p_confirm_repeat then
    return jsonb_build_object('created', 0, 'updated', 0, 'unchanged', 0,
      'duplicate_of', jsonb_build_object('filename', v_prev.filename, 'imported_at', v_prev.imported_at,
        'imported_by', (select email from profiles where id = v_prev.imported_by)));
  end if;

  for v_row in select * from bulk_import_rows order by ord loop
    select id into v_id from bulk_items
     where bulk_item_key(name) = bulk_item_key(v_row.name) and bulk_item_key(category) = bulk_item_key(v_row.category);
    if v_id is null then
      insert into bulk_items (name, category, location, available)
      values (v_row.name, v_row.category, v_row.location, coalesce(v_row.qty_text::int, 0))
      returning id into v_id;
      insert into bulk_item_history (item_id, action, detail, quantity, actor_user_id)
      values (v_id, 'created', 'Imported from ' || p_filename, coalesce(v_row.qty_text::int, 0), v_actor);
      v_created := v_created + 1;
    elsif coalesce(v_row.qty_text::int, 0) > 0 then
      update bulk_items set available = available + v_row.qty_text::int where id = v_id;
      insert into bulk_item_history (item_id, action, detail, quantity, actor_user_id)
      values (v_id, 'receive_stock', 'Received via import from ' || p_filename
                || case when v_prev.id is not null then ' (confirmed as a new delivery of an earlier file)' else '' end,
              v_row.qty_text::int, v_actor);
      v_updated := v_updated + 1;
    else
      v_unchanged := v_unchanged + 1;
    end if;
  end loop;

  insert into import_events (imported_by, target_collection, filename, rows_created, rows_updated, rows_errored, summary)
  values (v_actor, 'bulk_items', p_filename, v_created, v_updated, 0,
          jsonb_build_object('total', v_created + v_updated + v_unchanged, 'unchanged', v_unchanged,
                             'content_hash', v_hash, 'repeat_of', v_prev.id))
  returning id into v_event;
  insert into bulk_import_receipts (content_hash, filename, import_event_id, repeat_of, imported_by)
  values (v_hash, p_filename, v_event, v_prev.id, v_actor);

  return jsonb_build_object('created', v_created, 'updated', v_updated, 'unchanged', v_unchanged, 'repeat_of', v_prev.id);
end;
$$;

revoke execute on function commit_bulk_import(text, jsonb, boolean) from public, anon;
grant execute on function commit_bulk_import(text, jsonb, boolean) to authenticated;

-- Adding a Bulk Stock item that already exists (same name + category,
-- case and spacing ignored) now gets a clear message instead of a raw
-- constraint error. Otherwise exactly as in 20260901000012.
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

  begin
    insert into bulk_items (name, category, location, available)
    values (p_name, p_category, p_location, v_qty)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'A Bulk Stock item "%" in category "%" already exists — use Receive stock on it instead', btrim(p_name), btrim(p_category)
      using errcode = 'unique_violation';
  end;

  insert into bulk_item_history (item_id, action, detail, quantity, actor_user_id)
  values (v_id, 'created', 'Added to bulk stock', v_qty, v_actor);

  return v_id;
end;
$$;

-- ------------------------------------------------------- backup/restore
-- As 20260901000028, plus status_decision_required and bulk_import_receipts.

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
    'offboarding_checklists', 'import_events', 'employees', 'equipment_issues', 'employee_history',
    'bulk_import_receipts'];
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
  delete from bulk_import_receipts;
  perform restore_backup_load(p_payload);
  perform set_config('equipment.sync_disabled', 'on', true);

  update employees e set
    first_name = t.first_name, last_name = t.last_name, department = t.department, job_title = t.job_title,
    hr_status = t.hr_status, manager = t.manager, start_date = t.start_date, employment_status = t.employment_status,
    reactivation_pending = coalesce(t.reactivation_pending, false), status_changed_at = t.status_changed_at,
    status_decision_required = coalesce(t.status_decision_required, false),
    updated_at = t.updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'employees', '[]'::jsonb))
    as t(id uuid, first_name text, last_name text, department text, job_title text, hr_status text, manager text,
         start_date date, employment_status employment_status, reactivation_pending boolean, status_decision_required boolean,
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

  insert into bulk_import_receipts (id, content_hash, filename, import_event_id, repeat_of, imported_by, imported_at)
  select t.id, t.content_hash, t.filename, t.import_event_id, t.repeat_of, p.id, t.imported_at
  from jsonb_to_recordset(coalesce(p_payload -> 'bulk_import_receipts', '[]'::jsonb))
    as t(id uuid, content_hash text, filename text, import_event_id uuid, repeat_of uuid, imported_by uuid, imported_at timestamptz)
  left join profiles p on p.id = t.imported_by;

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
