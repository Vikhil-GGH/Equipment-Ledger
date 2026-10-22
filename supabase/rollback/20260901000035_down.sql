-- Rollback for 20260901000035_decommissioned_guard_rails.sql: restores the
-- 033/034 definitions. Run inside a transaction. Not in supabase/migrations/.

drop function perform_lifecycle_action(asset_collection, uuid, asset_action, text, text, boolean);
drop function perform_swap(asset_collection, uuid, uuid, text, boolean);

create function perform_lifecycle_action(p_collection asset_collection, p_asset_id uuid, p_action asset_action, p_assigned_to text DEFAULT NULL::text, p_detail text DEFAULT NULL::text)
returns asset_collection
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
  v_current_status asset_status;
  v_new_status asset_status;
  v_moved_from_inventory boolean;
  v_row record;
  v_assigned text;
begin
  select role into v_role from profiles where id = v_actor;

  if v_role is null then
    raise exception 'Not authorized';
  end if;
  if v_role = 'viewer' then
    raise exception 'Viewers cannot perform lifecycle actions';
  end if;
  if v_role = 'scanner' and p_action not in ('provide', 'collect') then
    raise exception 'Scanners can only Provide or Collect';
  end if;

  execute format('select status from %I where id = $1 for update', v_table)
    into v_current_status
    using p_asset_id;

  if v_current_status is null then
    raise exception 'Asset not found in %', v_table;
  end if;

  v_new_status := case
    when p_action = 'provide' and v_current_status in ('available', 'retained', 'decommissioned')
      then 'provided'::asset_status
    when p_action = 'retain' and v_current_status in ('available', 'decommissioned')
      then 'retained'::asset_status
    when p_action = 'mark_damaged' and v_current_status in ('available', 'provided', 'retained', 'decommissioned')
      then 'damaged'::asset_status
    when p_action = 'collect' and v_current_status = 'provided'
      then 'available'::asset_status
    when p_action = 'transfer' and v_current_status = 'provided'
      then 'provided'::asset_status
    when p_action = 'decommission' and v_current_status = 'provided'
      then 'decommissioned'::asset_status
    when p_action = 'mark_repaired' and v_current_status = 'damaged'
      then 'available'::asset_status
    when p_action = 'mark_nonfunctional' and v_current_status = 'damaged'
      then 'nonfunctional'::asset_status
    else null
  end;

  if v_new_status is null then
    raise exception 'Action % is not allowed from status %', p_action, v_current_status;
  end if;

  if p_action in ('provide', 'transfer') and coalesce(btrim(p_assigned_to), '') = '' then
    raise exception 'assigned_to is required for %', p_action;
  end if;

  -- 033: a set-aside device can be provided only if it is really free.
  if p_action = 'provide' and v_current_status in ('retained', 'decommissioned') then
    execute format('select assigned_to from %I where id = $1', v_table) into v_assigned using p_asset_id;
    if nullif(btrim(v_assigned), '') is not null then
      raise exception 'This device is still assigned to % (an authorized retention or an unfinished return). Collect it first, then provide it.', btrim(v_assigned);
    end if;
    if exists (select 1 from equipment_issues where asset_id = p_asset_id and status = 'open') then
      raise exception 'This device already has an open issue in the equipment register. Return it first, then provide it.';
    end if;
  end if;

  -- Laptop Inventory -> Active Laptops (NP): Provide moves the row instead
  -- of updating it in place.
  if p_collection = 'serialized_assets' and p_action = 'provide' then
    select * into v_row from serialized_assets where id = p_asset_id;

    insert into active_laptops_np
      (id, name, category, serial, status, assigned_to, location, created_at, updated_at, moved_from_inventory)
    values
      (v_row.id, v_row.name, v_row.category, v_row.serial, 'provided', p_assigned_to, v_row.location, v_row.created_at, now(), true);

    insert into active_laptops_np_history (asset_id, date, action, detail, actor_user_id)
    select asset_id, date, action, detail, actor_user_id from serialized_asset_history where asset_id = p_asset_id;

    insert into active_laptops_np_history (asset_id, action, detail, actor_user_id)
    values (p_asset_id, 'provide', nullif(p_detail, ''), v_actor);

    delete from serialized_assets where id = p_asset_id; -- cascades serialized_asset_history

    return 'active_laptops_np'::asset_collection;
  end if;

  -- Active Laptops (NP) -> Laptop Inventory: Collect/Decommission on a
  -- laptop that arrived here via the move above returns it to Inventory. A
  -- genuine Next Perimeter laptop (moved_from_inventory = false) never
  -- moves — it stays here regardless of status, same as before this change.
  if p_collection = 'active_laptops_np' and p_action in ('collect', 'decommission') then
    select moved_from_inventory into v_moved_from_inventory
      from active_laptops_np where id = p_asset_id;

    if v_moved_from_inventory then
      select * into v_row from active_laptops_np where id = p_asset_id;

      insert into serialized_assets
        (id, name, category, serial, status, assigned_to, location, created_at, updated_at)
      values
        (v_row.id, v_row.name, v_row.category, v_row.serial, v_new_status, null, v_row.location, v_row.created_at, now());

      insert into serialized_asset_history (asset_id, date, action, detail, actor_user_id)
      select asset_id, date, action, detail, actor_user_id from active_laptops_np_history where asset_id = p_asset_id;

      insert into serialized_asset_history (asset_id, action, detail, actor_user_id)
      values (p_asset_id, p_action::text, nullif(p_detail, ''), v_actor);

      delete from active_laptops_np where id = p_asset_id; -- cascades active_laptops_np_history

      return 'serialized_assets'::asset_collection;
    end if;
  end if;

  if p_action in ('provide', 'transfer') then
    execute format('update %I set status = $1, assigned_to = $2 where id = $3', v_table)
      using v_new_status, p_assigned_to, p_asset_id;
  elsif p_action in ('collect', 'decommission') then
    execute format('update %I set status = $1, assigned_to = null where id = $2', v_table)
      using v_new_status, p_asset_id;
  else
    execute format('update %I set status = $1 where id = $2', v_table)
      using v_new_status, p_asset_id;
  end if;

  execute format(
    'insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)',
    v_history_table
  ) using p_asset_id, p_action::text, nullif(p_detail, ''), v_actor;

  return p_collection;
end;
$$;

create function perform_swap(p_collection asset_collection, p_old_asset_id uuid, p_new_asset_id uuid, p_reason text)

returns asset_collection
language plpgsql
security definer
set search_path = public
as $fn$
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
  v_old_status asset_status;
  v_old_serial text;
  v_assignee text;
  v_old_moved_from_inventory boolean := false;
  v_new_status asset_status;
  v_new_serial text;
  v_new_in_inventory boolean := false;
  v_row record;
begin
  select role into v_role from profiles where id = v_actor;
  if v_role is null or v_role not in ('admin', 'editor') then
    raise exception 'Not authorized to perform a swap';
  end if;

  if p_old_asset_id = p_new_asset_id then
    raise exception 'Cannot swap an asset with itself';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required for a swap';
  end if;

  execute format('select status, serial, assigned_to from %I where id = $1 for update', v_table)
    into v_old_status, v_old_serial, v_assignee
    using p_old_asset_id;
  if v_old_status is null then
    raise exception 'Asset not found';
  end if;
  if v_old_status <> 'provided' then
    raise exception 'Swap is only allowed while the asset is provided (currently %)', v_old_status;
  end if;

  if p_collection = 'active_laptops_np' then
    select moved_from_inventory into v_old_moved_from_inventory
      from active_laptops_np where id = p_old_asset_id;
  end if;

  execute format('select status, serial from %I where id = $1 for update', v_table)
    into v_new_status, v_new_serial
    using p_new_asset_id;

  if v_new_status is null and p_collection = 'active_laptops_np' then
    select status, serial into v_new_status, v_new_serial
      from serialized_assets where id = p_new_asset_id for update;
    if v_new_status is not null then
      v_new_in_inventory := true;
    end if;
  end if;

  if v_new_status is null then
    raise exception 'Replacement asset not found';
  end if;
  if v_new_status not in ('available', 'decommissioned') then
    raise exception 'Replacement asset must be available or decommissioned (currently %)', v_new_status;
  end if;

  -- ---------------------------------------------------------- old asset
  execute format('update %I set status = $1, assigned_to = null where id = $2', v_table)
    using 'damaged'::asset_status, p_old_asset_id;
  execute format(
    'insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)',
    v_history_table
  ) using p_old_asset_id, 'swap',
    format('Swapped out (reason: %s). Replaced by serial %s.', p_reason, v_new_serial), v_actor;

  if v_old_moved_from_inventory then
    select * into v_row from active_laptops_np where id = p_old_asset_id;

    insert into serialized_assets
      (id, name, category, serial, status, assigned_to, location, created_at, updated_at)
    values
      (v_row.id, v_row.name, v_row.category, v_row.serial, 'damaged', null, v_row.location, v_row.created_at, now());

    insert into serialized_asset_history (asset_id, date, action, detail, actor_user_id)
    select asset_id, date, action, detail, actor_user_id from active_laptops_np_history where asset_id = p_old_asset_id;

    delete from active_laptops_np where id = p_old_asset_id;
  end if;

  -- ---------------------------------------------------------- new asset
  if v_new_in_inventory then
    select * into v_row from serialized_assets where id = p_new_asset_id;

    insert into active_laptops_np
      (id, name, category, serial, status, assigned_to, location, created_at, updated_at, moved_from_inventory)
    values
      (v_row.id, v_row.name, v_row.category, v_row.serial, 'provided', v_assignee, v_row.location, v_row.created_at, now(), true);

    insert into active_laptops_np_history (asset_id, date, action, detail, actor_user_id)
    select asset_id, date, action, detail, actor_user_id from serialized_asset_history where asset_id = p_new_asset_id;

    insert into active_laptops_np_history (asset_id, action, detail, actor_user_id)
    values (p_new_asset_id, 'swap',
      format('Swapped in (reason: %s). Replaces serial %s.', p_reason, v_old_serial), v_actor);

    delete from serialized_assets where id = p_new_asset_id;
  else
    execute format('update %I set status = $1, assigned_to = $2 where id = $3', v_table)
      using 'provided'::asset_status, v_assignee, p_new_asset_id;
    execute format(
      'insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)',
      v_history_table
    ) using p_new_asset_id, 'swap',
      format('Swapped in (reason: %s). Replaces serial %s.', p_reason, v_old_serial), v_actor;
  end if;

  if v_old_moved_from_inventory then
    return 'serialized_assets'::asset_collection;
  end if;
  return p_collection;
end;
$fn$;

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
