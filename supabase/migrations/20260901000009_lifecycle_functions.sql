-- =========================================================================
-- perform_lifecycle_action — the real, server-enforced state machine for
-- Serialized Assets and Active Laptops (NP). One implementation shared by
-- both collections via p_collection (safe: asset_collection is an enum, so
-- format(%I, p_collection::text) can never be fed an arbitrary identifier).
--
-- Transition table (mirrors src/lib/lifecycle.ts exactly — keep both in
-- sync if this ever changes):
--   available     -> provide -> provided | retain -> retained | mark_damaged -> damaged
--   provided      -> collect -> available | transfer -> provided | mark_damaged -> damaged
--                  | decommission -> decommissioned
--   retained      -> provide -> provided | mark_damaged -> damaged
--   damaged       -> mark_repaired -> available | mark_nonfunctional -> nonfunctional (terminal)
--   decommissioned-> provide -> provided | retain -> retained | mark_damaged -> damaged
--   nonfunctional -> (terminal, no actions)
--
-- 'swap' is intentionally not handled here — it's a two-row atomic
-- transaction and gets its own function (perform_swap) in Phase 5.
-- =========================================================================
create function perform_lifecycle_action(
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
  v_history_table text := p_collection::text || '_history';
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
  -- Scanner is deliberately narrower than Editor: basic check-out (provide)
  -- and check-in (collect) only, per the mobile scan-to-action flow.
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
