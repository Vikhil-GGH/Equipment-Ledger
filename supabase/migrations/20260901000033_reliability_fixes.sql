-- =========================================================================
-- Reliability and data-accuracy fixes (found by the 2026-10-21 browser
-- checks on the 030 baseline). Small and additive: no row is changed, no
-- column is added. Rollback: supabase/rollback/20260901000033_down.sql
--
-- (Numbered 033 so it can never be confused with the retired, archived 031.)
--
-- 1. Bulk Stock: perform_bulk_action checked FOUND after an EXECUTE, which
--    never sets it, so an unknown item surfaced as a foreign-key error
--    (and a rewrite that touched the role SELECT once broke every action).
--    The item row is now locked and checked explicitly, for every action.
--
-- 2. Authorized retention: a device kept by its employee with approval
--    stays Provided and assigned, with its register row closed as
--    retained_authorized. equipment_register_mismatches reported every such
--    device as a mismatch. Custody now also counts a retained_authorized
--    row while it is the device's latest register row AND the device is
--    still assigned to that same person. Anything else (assigned to
--    someone else, or to anyone with no register row at all) is still
--    reported.
--
-- 3. Assignee names: devices.assigned_to is trimmed, its spaces collapsed,
--    and replaced by the employee's recorded name when exactly one employee
--    matches. Only when the value is inserted or changed: existing rows are
--    not rewritten. Employee ids and register history are untouched.
--
-- 4. Ambiguous names: assigning a device to a name shared by more than one
--    employee (without choosing which, as Onboarding does) used to be
--    recorded silently with no employee link. It is now refused with a
--    message that says what to do.
--
-- 5. Devices issued from the register must be Available (not Retained or
--    Decommissioned).
--
-- 6. One in-progress offboarding per employee. Checked when a record is
--    created or linked to an employee, so duplicates that already exist
--    stay as they are (history is never rewritten) and only new ones are
--    prevented. A completed record never blocks a later offboarding.
-- =========================================================================

-- ----------------------------------------------------------- 1. Bulk Stock
create or replace function perform_bulk_action(
  p_item_id uuid,
  p_action bulk_action,
  p_quantity integer,
  p_from_bucket bulk_bucket default null,
  p_detail text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_role user_role;
  v_from bulk_bucket;
  v_to bulk_bucket;
  v_current integer;
begin
  select role into v_role from profiles where id = v_actor;
  if v_role is null or v_role not in ('admin', 'editor') then
    raise exception 'Not authorized to modify bulk stock';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be a positive number';
  end if;

  v_from := case p_action
    when 'receive_stock' then null
    when 'issue' then 'available'::bulk_bucket
    when 'return' then 'provided'::bulk_bucket
    when 'retain' then 'available'::bulk_bucket
    when 'repair' then 'damaged'::bulk_bucket
    when 'mark_damaged' then p_from_bucket
    when 'decommission' then p_from_bucket
  end;

  v_to := case p_action
    when 'receive_stock' then 'available'::bulk_bucket
    when 'issue' then 'provided'::bulk_bucket
    when 'return' then 'available'::bulk_bucket
    when 'retain' then 'retained'::bulk_bucket
    when 'repair' then 'available'::bulk_bucket
    when 'mark_damaged' then 'damaged'::bulk_bucket
    when 'decommission' then 'decommissioned'::bulk_bucket
  end;

  if p_action in ('mark_damaged', 'decommission') and v_from is null then
    raise exception 'from_bucket is required for %', p_action;
  end if;

  -- PERFORM sets FOUND (EXECUTE does not). Lock the row for every action.
  perform 1 from bulk_items where id = p_item_id for update;
  if not found then
    raise exception 'Bulk item not found';
  end if;

  if v_from is not null then
    execute format('select %I from bulk_items where id = $1', v_from::text)
      into v_current
      using p_item_id;

    if v_current < p_quantity then
      raise exception 'Insufficient quantity in % (have %, need %)', v_from, v_current, p_quantity;
    end if;

    execute format('update bulk_items set %I = %I - $1 where id = $2', v_from::text, v_from::text)
      using p_quantity, p_item_id;
  end if;

  execute format('update bulk_items set %I = %I + $1 where id = $2', v_to::text, v_to::text)
    using p_quantity, p_item_id;

  insert into bulk_item_history (item_id, action, detail, quantity, actor_user_id)
  values (p_item_id, p_action::text, nullif(p_detail, ''), p_quantity, v_actor);
end;
$$;

-- ----------------------------------------------- 2. Register mismatch view
create or replace view equipment_register_mismatches
  with (security_invoker = true) as
with devices as (
  select 'serialized_assets'::asset_collection as collection, id, serial, assigned_to from serialized_assets
  union all select 'active_laptops_np', id, serial, assigned_to from active_laptops_np
  union all select 'monitors', id, serial, assigned_to from monitors
  union all select 'other_equipment', id, serial, assigned_to from other_equipment
)
select d.collection, d.id as asset_id, d.serial, d.assigned_to, i.assignee_name as register_assignee
from devices d
left join equipment_issues i on i.asset_id = d.id and i.status = 'open'
where case
  -- An open register row must name the person the device is assigned to.
  when i.id is not null then normalize_person_name(d.assigned_to) is distinct from normalize_person_name(i.assignee_name)
  -- No open row: only fine if unassigned, or kept by authorized retention
  -- (the latest register row for the device, for this same person).
  else normalize_person_name(d.assigned_to) is not null
    and not exists (
      select 1 from equipment_issues r
      where r.asset_id = d.id
        and r.status = 'retained_authorized'
        and normalize_person_name(r.assignee_name) = normalize_person_name(d.assigned_to)
        and not exists (select 1 from equipment_issues later where later.asset_id = d.id and later.issued_at > r.issued_at)
    )
  end;

-- ---------------------------------------------- 3. Canonical assignee names
create function canonical_assignee(p_name text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when nullif(btrim(coalesce(p_name, '')), '') is null then null
    else coalesce(
      (select e.full_name from employees e
        where e.name_key = normalize_person_name(p_name)
          and (select count(*) from employees x where x.name_key = e.name_key) = 1),
      regexp_replace(btrim(p_name), '\s+', ' ', 'g')
    )
  end;
$$;
revoke execute on function canonical_assignee(text) from public, anon, authenticated;

create function normalize_device_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Restores and rebuilds must reproduce rows exactly.
  if equipment_setting('equipment.sync_disabled') = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to then
    new.assigned_to := canonical_assignee(new.assigned_to);
  end if;
  return new;
end;
$$;
revoke execute on function normalize_device_assignee() from public, anon, authenticated;

create trigger serialized_assets_normalize_assignee
  before insert or update of assigned_to on serialized_assets
  for each row execute function normalize_device_assignee();
create trigger active_laptops_np_normalize_assignee
  before insert or update of assigned_to on active_laptops_np
  for each row execute function normalize_device_assignee();
create trigger monitors_normalize_assignee
  before insert or update of assigned_to on monitors
  for each row execute function normalize_device_assignee();
create trigger other_equipment_normalize_assignee
  before insert or update of assigned_to on other_equipment
  for each row execute function normalize_device_assignee();

-- ------------------------------------- 4. Ambiguous names are not recorded
create or replace function sync_equipment_register()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := nullif(btrim(new.assigned_to), '');
  v_open equipment_issues;
  v_status equipment_issue_status;
  v_employee uuid;
  v_ambiguous boolean;
  v_context text := equipment_setting('equipment.context');
begin
  if equipment_setting('equipment.sync_disabled') = 'on' then
    return null;
  end if;

  select * into v_open from equipment_issues where asset_id = new.id and status = 'open' for update;

  if v_open.id is not null then
    if v_name is not null and normalize_person_name(v_name) = normalize_person_name(v_open.assignee_name) then
      -- Same person (e.g. the device moved between Inventory and Active
      -- Laptops, or was marked damaged while assigned): keep the row open.
      if v_open.asset_collection::text <> tg_table_name then
        update equipment_issues set asset_collection = tg_table_name::asset_collection where id = v_open.id;
      end if;
      return null;
    end if;

    v_status := coalesce(
      equipment_setting('equipment.close_status')::equipment_issue_status,
      case
        when v_name is not null then 'transferred'
        when v_context = 'import' then 'unassigned'
        when new.status = 'damaged' then 'returned_damaged'
        when new.status = 'decommissioned' then 'decommissioned'
        when new.status::text = 'lost' then 'lost'
        else 'returned'
      end::equipment_issue_status
    );
    update equipment_issues
      set status = v_status,
          closed_at = now(),
          closed_by = auth.uid(),
          close_note = coalesce(equipment_setting('equipment.close_note'), close_note),
          approved_by = case when v_status = 'retained_authorized' then auth.uid() else approved_by end,
          offboarding_id = coalesce(equipment_setting('equipment.offboarding_id')::uuid, offboarding_id)
      where id = v_open.id;
  end if;

  if v_name is not null then
    select r.employee_id, r.ambiguous into v_employee, v_ambiguous
      from resolve_employee(v_name, true, equipment_setting('equipment.employee_id')::uuid) r;
    if v_ambiguous then
      raise exception 'More than one employee is named "%". Issue this from the employee''s Onboarding page, or give the employees different names, so the equipment is linked to the right person.', v_name;
    end if;
    insert into equipment_issues
      (employee_id, assignee_name, employee_ambiguous, item_kind, asset_collection, asset_id,
       description, serial, issued_by, onboarding_id, source)
    values
      (v_employee, v_name, false, 'serialized', tg_table_name::asset_collection, new.id,
       new.name, new.serial, auth.uid(), equipment_setting('equipment.onboarding_id')::uuid,
       case when v_context in ('issue', 'import') then v_context else 'lifecycle' end);
  end if;
  return null;
end;
$$;

-- ------------------------------------- 5. Only Available devices are issued
create or replace function issue_equipment(
  p_employee_id uuid,
  p_collection asset_collection default null,
  p_asset_id uuid default null,
  p_bulk_item_id uuid default null,
  p_quantity integer default 1,
  p_onboarding_id uuid default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee employees;
  v_issue uuid;
  v_item bulk_items;
  v_status asset_status;
begin
  if not is_editor_or_admin() then
    raise exception 'Not authorized to issue equipment';
  end if;
  select * into v_employee from employees where id = p_employee_id;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if (p_asset_id is null) = (p_bulk_item_id is null) then
    raise exception 'Issue exactly one item: a device or a Bulk Stock item';
  end if;
  if p_onboarding_id is not null and not exists (select 1 from onboarding_checklists where id = p_onboarding_id) then
    raise exception 'Onboarding record not found';
  end if;

  perform set_config('equipment.context', 'issue', true);
  perform set_config('equipment.employee_id', v_employee.id::text, true);
  perform set_config('equipment.onboarding_id', coalesce(p_onboarding_id::text, ''), true);

  if p_asset_id is not null then
    if p_collection is null then
      raise exception 'p_collection is required for a device';
    end if;
    execute format('select status from %I where id = $1', p_collection::text) into v_status using p_asset_id;
    if v_status is null then
      raise exception 'Device not found';
    end if;
    if v_status <> 'available' then
      raise exception 'Only an Available device can be issued (this one is %)', v_status;
    end if;
    perform perform_lifecycle_action(p_collection, p_asset_id, 'provide', v_employee.full_name, p_note);
    select id into v_issue from equipment_issues where asset_id = p_asset_id and status = 'open';
    if v_issue is null then
      raise exception 'Register out of sync after issuing device %', p_asset_id;
    end if;
    -- A laptop issued during onboarding completes "Equipment assigned".
    if p_onboarding_id is not null and p_collection in ('serialized_assets', 'active_laptops_np') then
      update onboarding_checklists
        set equipment_assigned = true, assigned_asset_id = coalesce(assigned_asset_id, p_asset_id)
        where id = p_onboarding_id;
    end if;
  else
    if coalesce(p_quantity, 0) <= 0 then
      raise exception 'Quantity must be a positive number';
    end if;
    select * into v_item from bulk_items where id = p_bulk_item_id;
    if v_item.id is null then
      raise exception 'Bulk item not found';
    end if;
    perform perform_bulk_action(p_bulk_item_id, 'issue', p_quantity, null,
      coalesce(nullif(btrim(p_note), ''), 'Issued to ' || v_employee.full_name));
    insert into equipment_issues
      (employee_id, assignee_name, item_kind, bulk_item_id, quantity, description, issued_by, onboarding_id, source)
    values
      (v_employee.id, v_employee.full_name, 'bulk', p_bulk_item_id, p_quantity, v_item.name, auth.uid(), p_onboarding_id, 'issue')
    returning id into v_issue;
  end if;

  perform set_config('equipment.context', '', true);
  perform set_config('equipment.employee_id', '', true);
  perform set_config('equipment.onboarding_id', '', true);
  return v_issue;
end;
$$;

-- ------------------------- 6. One in-progress offboarding per employee
create function prevent_duplicate_offboarding()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if equipment_setting('equipment.sync_disabled') = 'on' then
    return new; -- restores bring historical rows back exactly as they were
  end if;
  if tg_op = 'UPDATE' and new.employee_id is not distinct from old.employee_id then
    return new; -- editing a record never trips this
  end if;
  if new.removed_access and new.laptop_outcome is not null then
    return new; -- a completed record is history, not "in progress"
  end if;
  if exists (
    select 1 from offboarding_checklists o
    where o.id is distinct from new.id
      and not (o.removed_access and o.laptop_outcome is not null)
      and (
        (new.employee_id is not null and o.employee_id = new.employee_id)
        or (normalize_person_name(o.employee_name) = normalize_person_name(new.employee_name)
            and (o.employee_id is null or new.employee_id is null))
      )
  ) then
    raise exception 'An offboarding for "%" is already in progress. Open that record instead of starting another.', new.employee_name;
  end if;
  return new;
end;
$$;
revoke execute on function prevent_duplicate_offboarding() from public, anon, authenticated;

create trigger offboarding_one_in_progress
  before insert or update of employee_id on offboarding_checklists
  for each row execute function prevent_duplicate_offboarding();
