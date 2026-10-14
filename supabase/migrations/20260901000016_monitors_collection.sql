-- =========================================================================
-- Monitors — its own collection, identical schema/lifecycle to Serialized
-- Assets and Active Laptops (NP) (see 20260901000003_ledger_tables.sql).
-- Naming follows the active_laptops_np convention (table name + '_history'),
-- not the serialized_assets one (singular 'asset'), so that the generic
-- p_collection::text || '_history' construction in perform_lifecycle_action
-- and create_asset resolves to 'monitors_history' without any change to
-- those functions.
-- =========================================================================
create table monitors (
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

create table monitors_history (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references monitors (id) on delete cascade,
  date timestamptz not null default now(),
  action text not null,
  detail text,
  actor_user_id uuid references profiles (id)
);

create index on monitors_history (asset_id);
create index on monitors (status);
create index on monitors (serial);

create trigger monitors_set_updated_at
  before update on monitors
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------- stats
create view monitors_stats
  with (security_invoker = true) as
select status, count(*) as count
from monitors
group by status;

-- --------------------------------------------------------------------- rls
alter table monitors enable row level security;
alter table monitors_history enable row level security;

create policy monitors_select_known on monitors
  for select using (is_known_user());

create policy monitors_insert on monitors
  for insert with check (is_editor_or_admin() or my_role() = 'scanner');

create policy monitors_update_editor on monitors
  for update using (is_editor_or_admin()) with check (is_editor_or_admin());

create policy monitors_delete_admin on monitors
  for delete using (is_admin());

create policy monitors_history_select_known on monitors_history
  for select using (is_known_user());

create policy monitors_history_insert_admin on monitors_history
  for insert with check (is_admin());

-- ---------------------------------------------------- function CASE updates
-- commit_asset_import and perform_swap look up the history table via an
-- explicit CASE (unlike perform_lifecycle_action/create_asset, which derive
-- it generically) — both need a 'monitors' branch added.
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

-- --------------------------------------------------- move existing data
-- The Sept 14 legacy backup import filed 31 monitors into Serialized Assets
-- because Monitors didn't exist as a collection yet. Move them here now,
-- carrying their history along, identified by the " Monitor" name suffix
-- every monitor row was imported with (e.g. "Sceptre Monitor") — no
-- Serialized Assets laptop/tablet/surface name matches that pattern.
with moved as (
  insert into monitors (name, category, serial, status, assigned_to, location, created_at, updated_at)
  select name, category, serial, status, assigned_to, location, created_at, updated_at
  from serialized_assets
  where name ~ ' Monitor$'
  returning id, serial
)
insert into monitors_history (asset_id, date, action, detail, actor_user_id)
select moved.id, h.date, h.action, h.detail, h.actor_user_id
from serialized_asset_history h
join serialized_assets sa on sa.id = h.asset_id
join moved on moved.serial = sa.serial
where sa.name ~ ' Monitor$';

delete from serialized_assets where name ~ ' Monitor$';
