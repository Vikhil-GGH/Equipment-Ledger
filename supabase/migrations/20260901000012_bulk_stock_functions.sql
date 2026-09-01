-- =========================================================================
-- Bulk Stock actions: each moves a quantity between named bucket columns on
-- bulk_items and logs a bulk_item_history row. Single function call = one
-- transaction, so a failure (insufficient quantity, bad bucket) leaves no
-- partial bucket update — matches the "atomic, no partial writes" spec.
--
-- Default from/to bucket mapping (documented assumption, easy to adjust):
--   receive_stock : (external) -> available
--   issue         : available  -> provided
--   return        : provided   -> available
--   retain        : available  -> retained
--   repair        : damaged    -> available
--   mark_damaged  : caller-specified source -> damaged
--   decommission  : caller-specified source -> decommissioned
-- Only mark_damaged/decommission need p_from_bucket — a unit can go bad or
-- get decommissioned from more than one place, everything else has one
-- unambiguous source.
-- =========================================================================
create function perform_bulk_action(
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
$$;

create function create_bulk_item(
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
