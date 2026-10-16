-- =========================================================================
-- Rollback for 20260901000027_inventory_integrity.sql
--
-- Removes the serial registry (serial_keys, its triggers, the review view
-- and normalize_serial) and restores commit_asset_import and restore_backup
-- exactly as 20260901000026 left them. No device, history, register,
-- checklist or import row is changed: 027 never modified data, and the
-- registry only mirrors the devices' own serials. Import log rows written
-- while 027 was in place keep their richer "summary" (extra keys only).
--
-- After this rollback the old behaviour returns: imports can overwrite
-- status/assignment again (C4), serial matching is exact per table (M1),
-- and restore does not check row counts (C5).
--
-- Run BEFORE 20260901000026_down.sql, inside a transaction.
-- Not in supabase/migrations/ — never auto-applied.
-- =========================================================================

drop function restore_backup(jsonb);
alter function restore_backup_load(jsonb) rename to restore_backup;
grant execute on function restore_backup(jsonb) to public, anon, authenticated;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment'] loop
    execute format('drop trigger %I on %I', v_table || '_enforce_serial_key', v_table);
    execute format('drop trigger %I on %I', v_table || '_release_serial_key', v_table);
  end loop;
end $$;

drop view serial_duplicate_candidates;
drop function enforce_serial_key();
drop function release_serial_key();
drop function rebuild_serial_keys();
drop table serial_keys;

-- commit_asset_import exactly as in 20260901000026.
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

  -- Tell the register's sync trigger that assignment changes come from an
  -- import (20260901000026).
  perform set_config('equipment.context', 'import', true);

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

drop function normalize_serial(text);
