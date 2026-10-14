-- =========================================================================
-- Other Equipment — its own collection, identical schema/lifecycle to
-- Serialized Assets, Active Laptops (NP) and Monitors (see
-- 20260901000003_ledger_tables.sql and 20260901000016_monitors_collection.sql).
-- Catch-all for serialized gear that doesn't fit the other three buckets
-- (docks, cables, peripherals, etc. that are still individually serial-
-- tracked rather than counted in bulk).
-- =========================================================================
create table other_equipment (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,
  serial text not null,
  status asset_status not null default 'available',
  assigned_to text,
  location text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (serial)
);

create table other_equipment_history (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references other_equipment (id) on delete cascade,
  date timestamptz not null default now(),
  action text not null,
  detail text,
  actor_user_id uuid references profiles (id)
);

create index on other_equipment_history (asset_id);
create index on other_equipment (status);
create index on other_equipment (serial);

create trigger other_equipment_set_updated_at
  before update on other_equipment
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------- stats
create view other_equipment_stats
  with (security_invoker = true) as
select status, count(*) as count
from other_equipment
group by status;

-- --------------------------------------------------------------------- rls
alter table other_equipment enable row level security;
alter table other_equipment_history enable row level security;

create policy other_equipment_select_known on other_equipment
  for select using (is_known_user());

create policy other_equipment_insert on other_equipment
  for insert with check (is_editor_or_admin() or my_role() = 'scanner');

create policy other_equipment_update_editor on other_equipment
  for update using (is_editor_or_admin()) with check (is_editor_or_admin());

create policy other_equipment_delete_admin on other_equipment
  for delete using (is_admin());

create policy other_equipment_history_select_known on other_equipment_history
  for select using (is_known_user());

create policy other_equipment_history_insert_admin on other_equipment_history
  for insert with check (is_admin());

-- ---------------------------------------------------- function CASE updates
-- perform_lifecycle_action and create_asset (20260901000011) look up the
-- history table via an explicit CASE that was never updated when Monitors
-- was added (20260901000016 only fixed commit_asset_import/perform_swap) —
-- for 'monitors' that CASE falls through to NULL and every Add/lifecycle
-- action on a Monitor fails. Fixed here while adding the 'other_equipment'
-- branch these two functions also need.
create or replace function perform_lifecycle_action(
  p_collection asset_collection,
  p_asset_id uuid,
  p_action asset_action,
  p_assigned_to text default null,
  p_detail text default null
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
    when 'monitors' then 'monitors_history'
    when 'other_equipment' then 'other_equipment_history'
  end;
  v_actor uuid := auth.uid();
  v_role user_role;
  v_current_status asset_status;
  v_new_status asset_status;
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
end;
$$;

create or replace function create_asset(
  p_collection asset_collection,
  p_name text,
  p_category text,
  p_serial text,
  p_status asset_status default 'available',
  p_assigned_to text default null,
  p_location text default null
)
returns uuid
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
  v_id uuid;
begin
  select role into v_role from profiles where id = v_actor;

  if v_role is null or v_role = 'viewer' then
    raise exception 'Not authorized to add assets';
  end if;

  execute format(
    'insert into %I (name, category, serial, status, assigned_to, location) values ($1,$2,$3,$4,$5,$6) returning id',
    v_table
  )
  into v_id
  using p_name, p_category, p_serial, p_status, p_assigned_to, p_location;

  execute format(
    'insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)',
    v_history_table
  ) using v_id, 'created', 'Added to ' || v_table, v_actor;

  return v_id;
end;
$$;

create or replace function commit_asset_import(
  p_collection asset_collection,
  p_filename text,
  p_rows jsonb
)
returns jsonb
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
  v_row jsonb;
  v_id uuid;
  v_created int := 0;
  v_updated int := 0;
begin
  select role into v_role from profiles where id = v_actor;
  if v_role is null or v_role not in ('admin', 'editor') then
    raise exception 'Not authorized to import';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    execute format('select id from %I where serial = $1', v_table)
      into v_id
      using (v_row ->> 'serial');

    if v_id is null then
      execute format(
        'insert into %I (name, category, serial, status, assigned_to, location) values ($1,$2,$3,$4,$5,$6) returning id',
        v_table
      )
      into v_id
      using
        v_row ->> 'name',
        v_row ->> 'category',
        v_row ->> 'serial',
        coalesce(nullif(v_row ->> 'status', ''), 'available')::asset_status,
        nullif(v_row ->> 'assigned_to', ''),
        nullif(v_row ->> 'location', '');

      execute format(
        'insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)',
        v_history_table
      ) using v_id, 'created', 'Imported from ' || p_filename, v_actor;

      v_created := v_created + 1;
    else
      execute format(
        'update %I set name = $1, category = $2, status = $3, assigned_to = $4, location = $5 where id = $6',
        v_table
      )
      using
        v_row ->> 'name',
        v_row ->> 'category',
        coalesce(nullif(v_row ->> 'status', ''), 'available')::asset_status,
        nullif(v_row ->> 'assigned_to', ''),
        nullif(v_row ->> 'location', ''),
        v_id;

      execute format(
        'insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)',
        v_history_table
      ) using v_id, 'imported', 'Updated via import from ' || p_filename, v_actor;

      v_updated := v_updated + 1;
    end if;
  end loop;

  insert into import_events
    (imported_by, target_collection, filename, rows_created, rows_updated, rows_errored, summary)
  values
    (v_actor, v_table, p_filename, v_created, v_updated, 0, jsonb_build_object('total', v_created + v_updated));

  return jsonb_build_object('created', v_created, 'updated', v_updated);
end;
$$;

create or replace function perform_swap(
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
    when 'monitors' then 'monitors_history'
    when 'other_equipment' then 'other_equipment_history'
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
