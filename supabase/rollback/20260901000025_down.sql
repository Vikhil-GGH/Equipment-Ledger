-- =========================================================================
-- Rollback for 20260901000025_add_lost_status.sql
--
-- Postgres cannot remove a value from an enum without rebuilding the type
-- (and every table and function using it), so 'lost' stays defined but
-- unused. Any device currently Lost is recorded in
-- private.lost_assets_backup_025 and set to 'nonfunctional' — the closest
-- pre-025 final state — with a history entry explaining why.
--
-- Run 20260901000026_down.sql FIRST. Run inside a transaction.
-- Not in supabase/migrations/ — never auto-applied.
-- =========================================================================
create schema if not exists private;
create table if not exists private.lost_assets_backup_025 (
  collection text not null,
  id uuid not null,
  serial text not null,
  captured_at timestamptz not null default now()
);

do $$
declare
  v_table text;
  v_history text;
begin
  foreach v_table in array array['serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment'] loop
    v_history := case v_table when 'serialized_assets' then 'serialized_asset_history' else v_table || '_history' end;
    execute format('insert into private.lost_assets_backup_025 (collection, id, serial) select %L, id, serial from %I where status = ''lost''', v_table, v_table);
    execute format(
      'insert into %I (asset_id, action, detail) select id, ''mark_nonfunctional'', ''Rollback of migration 025: status Lost mapped to Nonfunctional'' from %I where status = ''lost''',
      v_history, v_table);
    execute format('update %I set status = ''nonfunctional'' where status = ''lost''', v_table);
  end loop;
end $$;
