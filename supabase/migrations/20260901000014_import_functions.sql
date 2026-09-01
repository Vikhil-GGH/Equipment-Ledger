-- =========================================================================
-- Excel/paste import commit functions. The client does parsing, column
-- mapping, and pre-commit validation (required fields, duplicate serials
-- within the sheet, valid status values) — these functions are the atomic,
-- authoritative write: one call = one transaction, so a mid-import failure
-- never leaves a partial batch committed. Matching (create vs update) is
-- re-derived here from current DB state, not trusted from the client, so a
-- stale preview can't cause a row to be miscommitted.
--
-- Design note: imports set status directly rather than replaying rows
-- through perform_lifecycle_action's state machine. A bulk data load is a
-- trusted "this is the current/historical truth" operation, not a sequence
-- of individually-approved actions — requiring, say, a decommissioned
-- asset's historical row to legally transition through every intermediate
-- status would make legitimate historical imports impossible to load.
-- =========================================================================
create function commit_asset_import(
  p_collection asset_collection,
  p_filename text,
  p_rows jsonb -- [{serial, name, category, status, assigned_to, location}]
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

-- Bulk Stock has no serial column — matched by name+category instead (the
-- spec's documented fallback for non-serialized sheets). A matched row's
-- quantity is treated as newly received stock (added to 'available', with
-- a 'receive_stock' history entry) rather than overwriting bucket state —
-- overwriting would silently lose whatever's already provided/retained/
-- damaged/decommissioned, which a stock-count sheet doesn't know about.
create function commit_bulk_import(
  p_filename text,
  p_rows jsonb -- [{name, category, location, quantity}]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_role user_role;
  v_row jsonb;
  v_id uuid;
  v_qty integer;
  v_created int := 0;
  v_updated int := 0;
begin
  select role into v_role from profiles where id = v_actor;
  if v_role is null or v_role not in ('admin', 'editor') then
    raise exception 'Not authorized to import';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_qty := coalesce(nullif(v_row ->> 'quantity', '')::integer, 0);

    select id into v_id
      from bulk_items
      where lower(name) = lower(v_row ->> 'name') and lower(category) = lower(v_row ->> 'category')
      limit 1;

    if v_id is null then
      insert into bulk_items (name, category, location, available)
      values (v_row ->> 'name', v_row ->> 'category', nullif(v_row ->> 'location', ''), v_qty)
      returning id into v_id;

      insert into bulk_item_history (item_id, action, detail, quantity, actor_user_id)
      values (v_id, 'created', 'Imported from ' || p_filename, v_qty, v_actor);

      v_created := v_created + 1;
    else
      update bulk_items set available = available + v_qty where id = v_id;

      insert into bulk_item_history (item_id, action, detail, quantity, actor_user_id)
      values (v_id, 'receive_stock', 'Received via import from ' || p_filename, v_qty, v_actor);

      v_updated := v_updated + 1;
    end if;
  end loop;

  insert into import_events
    (imported_by, target_collection, filename, rows_created, rows_updated, rows_errored, summary)
  values
    (v_actor, 'bulk_items', p_filename, v_created, v_updated, 0, jsonb_build_object('total', v_created + v_updated));

  return jsonb_build_object('created', v_created, 'updated', v_updated);
end;
$$;
