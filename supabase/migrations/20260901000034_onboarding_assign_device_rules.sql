-- =========================================================================
-- Onboarding "Assign device" (by serial): align with the approved rules.
--
-- onboarding_assign_device accepted a Retained or Decommissioned device with
-- no further checks. It now applies the same rule as Provide on the device
-- page (033): a set-aside device can be assigned only if it is unassigned
-- (so not under an authorized retention) and has no open register issue.
-- Available devices behave exactly as before; so does every other status.
-- The function body is otherwise unchanged from 033 (including the way an
-- Inventory laptop moves into Active Laptops with its history).
--
-- No table, column, row or grant changes. Rollback:
-- supabase/rollback/20260901000034_down.sql
-- =========================================================================

create or replace function onboarding_assign_device(p_onboarding_id uuid, p_serial text, p_name text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_location text DEFAULT NULL::text)

returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor uuid := auth.uid();
  v_role user_role;
  v_employee text;
  v_asset_id uuid;
  v_status asset_status;
  v_row record;
  v_assigned text;
  v_pre_id uuid;
  v_pre_status asset_status;
begin
  select role into v_role from profiles where id = v_actor;
  if v_role is null or v_role not in ('admin', 'editor') then
    raise exception 'Not authorized';
  end if;

  select employee_name into v_employee from onboarding_checklists where id = p_onboarding_id;
  if v_employee is null then
    raise exception 'Onboarding record not found';
  end if;

  -- 034: a set-aside device can be assigned only if it is really free (same rule as Provide on the
  -- device page): unassigned (so not under an authorized retention) and no open register issue.
  -- Checked first, on the device as it is now: moving an Inventory laptop into Active Laptops
  -- below would itself close any open register row.
  select d.id, d.status, d.assigned_to into v_pre_id, v_pre_status, v_assigned
    from (select id, status, assigned_to, serial from active_laptops_np
          union all select id, status, assigned_to, serial from serialized_assets) d
    where d.serial = p_serial limit 1;
  if v_pre_status in ('retained', 'decommissioned') then
    if nullif(btrim(v_assigned), '') is not null then
      raise exception 'Device % is still assigned to % (an authorized retention or an unfinished return). Collect it first, then assign it.', p_serial, btrim(v_assigned);
    end if;
    if exists (select 1 from equipment_issues where asset_id = v_pre_id and status = 'open') then
      raise exception 'Device % already has an open issue in the equipment register. Return it first, then assign it.', p_serial;
    end if;
  end if;

  select id, status into v_asset_id, v_status
    from active_laptops_np where serial = p_serial for update;

  if v_asset_id is null then
    -- Not a Next Perimeter laptop already — it may instead be sitting
    -- unprovided in Laptop Inventory, which is the primary pool laptops
    -- are provided from since this migration.
    select * into v_row from serialized_assets where serial = p_serial for update;
    if v_row.id is not null then
      insert into active_laptops_np
        (id, name, category, serial, status, assigned_to, location, created_at, updated_at, moved_from_inventory)
      values
        (v_row.id, v_row.name, v_row.category, v_row.serial, v_row.status, v_row.assigned_to, v_row.location, v_row.created_at, now(), true);

      insert into active_laptops_np_history (asset_id, date, action, detail, actor_user_id)
      select asset_id, date, action, detail, actor_user_id from serialized_asset_history where asset_id = v_row.id;

      delete from serialized_assets where id = v_row.id;

      v_asset_id := v_row.id;
      v_status := v_row.status;
    end if;
  end if;

  if v_asset_id is null then
    if p_name is null or p_category is null then
      raise exception 'name and category are required to add a new device for serial %', p_serial;
    end if;

    insert into active_laptops_np (name, category, serial, status, location)
    values (p_name, p_category, p_serial, 'available', p_location)
    returning id into v_asset_id;

    insert into active_laptops_np_history (asset_id, action, detail, actor_user_id)
    values (v_asset_id, 'created', 'Added during onboarding for ' || v_employee, v_actor);

    v_status := 'available';
  end if;

  if v_status not in ('available', 'retained', 'decommissioned') then
    raise exception 'Device % is not available to assign (currently %)', p_serial, v_status;
  end if;

  update active_laptops_np set status = 'provided', assigned_to = v_employee where id = v_asset_id;

  insert into active_laptops_np_history (asset_id, action, detail, actor_user_id)
  values (v_asset_id, 'provide', 'Assigned during onboarding for ' || v_employee, v_actor);

  update onboarding_checklists
    set equipment_assigned = true, assigned_asset_id = v_asset_id
    where id = p_onboarding_id;

  return v_asset_id;
end;
$fn$;
