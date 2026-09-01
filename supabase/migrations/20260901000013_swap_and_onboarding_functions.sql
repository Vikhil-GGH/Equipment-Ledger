-- =========================================================================
-- perform_swap — replaces a broken device and reassigns the employee in one
-- atomic transaction. Only valid when the outgoing asset is 'provided'.
-- Candidates for the replacement are any asset in the SAME collection with
-- status 'available' or 'decommissioned' (client fetches that list; this
-- function re-validates it server-side rather than trusting the dropdown).
-- =========================================================================
create function perform_swap(
  p_collection asset_collection,
  p_old_asset_id uuid,
  p_new_asset_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table text := p_collection::text;
  v_history_table text := case p_collection
    when 'serialized_assets' then 'serialized_asset_history'
    when 'active_laptops_np' then 'active_laptops_np_history'
  end;
  v_actor uuid := auth.uid();
  v_role user_role;
  v_old_status asset_status;
  v_old_serial text;
  v_assignee text;
  v_new_status asset_status;
  v_new_serial text;
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

  execute format('select status, serial from %I where id = $1 for update', v_table)
    into v_new_status, v_new_serial
    using p_new_asset_id;
  if v_new_status is null then
    raise exception 'Replacement asset not found';
  end if;
  if v_new_status not in ('available', 'decommissioned') then
    raise exception 'Replacement asset must be available or decommissioned (currently %)', v_new_status;
  end if;

  execute format('update %I set status = $1, assigned_to = null where id = $2', v_table)
    using 'damaged'::asset_status, p_old_asset_id;
  execute format(
    'insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)',
    v_history_table
  ) using p_old_asset_id, 'swap',
    format('Swapped out (reason: %s). Replaced by serial %s.', p_reason, v_new_serial), v_actor;

  execute format('update %I set status = $1, assigned_to = $2 where id = $3', v_table)
    using 'provided'::asset_status, v_assignee, p_new_asset_id;
  execute format(
    'insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)',
    v_history_table
  ) using p_new_asset_id, 'swap',
    format('Swapped in (reason: %s). Replaces serial %s.', p_reason, v_old_serial), v_actor;
end;
$$;

-- =========================================================================
-- onboarding_assign_device — the "enter a serial number" step of
-- onboarding. If the serial already exists in active_laptops_np it's
-- assigned via the normal provide transition; if not, it's created there
-- first (name/category required in that case) and then assigned — this is
-- the "moves it into Active Laptops (NP)" behavior from the spec. Marks the
-- checklist's "Equipment assigned" step done as part of the same
-- transaction (documented assumption: assigning IS what completes that
-- step, rather than being a separate manual checkbox).
-- =========================================================================
create function onboarding_assign_device(
  p_onboarding_id uuid,
  p_serial text,
  p_name text default null,
  p_category text default null,
  p_location text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_role user_role;
  v_employee text;
  v_asset_id uuid;
  v_status asset_status;
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
$$;
