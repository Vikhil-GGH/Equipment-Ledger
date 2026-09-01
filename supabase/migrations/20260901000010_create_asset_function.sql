-- Wraps asset creation in a function too (rather than a raw client INSERT)
-- so the "created" event always gets a history row, same as every other
-- lifecycle action — an asset with no history entries would be a gap in
-- the audit trail the spec calls out as a core feature.
create function create_asset(
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
  v_history_table text := p_collection::text || '_history';
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
