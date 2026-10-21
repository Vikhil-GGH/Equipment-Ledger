-- =========================================================================
-- Rollback for 20260901000033_reliability_fixes.sql. Restores the 030
-- definitions exactly (taken from hosted staging, which was on 030) and
-- removes the objects 033 added. No data is touched. Run inside a
-- transaction. Not in supabase/migrations/ — never auto-applied.
-- =========================================================================

drop trigger offboarding_one_in_progress on offboarding_checklists;
drop function prevent_duplicate_offboarding();

drop trigger serialized_assets_normalize_assignee on serialized_assets;
drop trigger active_laptops_np_normalize_assignee on active_laptops_np;
drop trigger monitors_normalize_assignee on monitors;
drop trigger other_equipment_normalize_assignee on other_equipment;
drop function normalize_device_assignee();
drop function canonical_assignee(text);

CREATE OR REPLACE FUNCTION public.perform_bulk_action(p_item_id uuid, p_action bulk_action, p_quantity integer, p_from_bucket bulk_bucket DEFAULT NULL::bulk_bucket, p_detail text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_role user_role;
  v_from bulk_bucket;
  v_to bulk_bucket;
  v_current integer;
  v_found boolean;
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

  if v_from is not null then
    execute format('select %I from bulk_items where id = $1 for update', v_from::text)
      into v_current
      using p_item_id;

    if not found then
      raise exception 'Bulk item not found';
    end if;
    if v_current < p_quantity then
      raise exception 'Insufficient quantity in % (have %, need %)', v_from, v_current, p_quantity;
    end if;

    execute format('update bulk_items set %I = %I - $1 where id = $2', v_from::text, v_from::text)
      using p_quantity, p_item_id;
  else
    perform 1 from bulk_items where id = p_item_id for update;
    if not found then
      raise exception 'Bulk item not found';
    end if;
  end if;

  execute format('update bulk_items set %I = %I + $1 where id = $2', v_to::text, v_to::text)
    using p_quantity, p_item_id;

  insert into bulk_item_history (item_id, action, detail, quantity, actor_user_id)
  values (p_item_id, p_action::text, nullif(p_detail, ''), p_quantity, v_actor);
end;
$function$;

CREATE OR REPLACE FUNCTION public.sync_equipment_register()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    insert into equipment_issues
      (employee_id, assignee_name, employee_ambiguous, item_kind, asset_collection, asset_id,
       description, serial, issued_by, onboarding_id, source)
    values
      (v_employee, v_name, v_ambiguous, 'serialized', tg_table_name::asset_collection, new.id,
       new.name, new.serial, auth.uid(), equipment_setting('equipment.onboarding_id')::uuid,
       case when v_context in ('issue', 'import') then v_context else 'lifecycle' end);
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.issue_equipment(p_employee_id uuid, p_collection asset_collection DEFAULT NULL::asset_collection, p_asset_id uuid DEFAULT NULL::uuid, p_bulk_item_id uuid DEFAULT NULL::uuid, p_quantity integer DEFAULT 1, p_onboarding_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_employee employees;
  v_issue uuid;
  v_item bulk_items;
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
$function$;

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
where normalize_person_name(d.assigned_to) is distinct from normalize_person_name(i.assignee_name);
