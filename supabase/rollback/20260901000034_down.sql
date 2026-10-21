-- Rollback for 20260901000034_onboarding_assign_device_rules.sql: restores the
-- 033 definition exactly (taken from hosted staging). Run inside a transaction.
-- Not in supabase/migrations/ — never auto-applied.

CREATE OR REPLACE FUNCTION public.onboarding_assign_device(p_onboarding_id uuid, p_serial text, p_name text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_location text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_role user_role;
  v_employee text;
  v_asset_id uuid;
  v_status asset_status;
  v_row record;
begin
  select role into v_role from profiles where id = v_actor;
  if v_role is null or v_role not in ('admin', 'editor') then
    raise exception 'Not authorized';
  end if;

  select employee_name into v_employee from onboarding_checklists where id = p_onboarding_id;
  if v_employee is null then
    raise exception 'Onboarding record not found';
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
$function$;
