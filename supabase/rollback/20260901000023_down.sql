-- =========================================================================
-- Rollback for 20260901000023_remove_raw_ledger_writes.sql
--
-- Recreates the exact policies dropped by 023, as originally defined in
-- 20260901000007_rls_policies.sql, 20260901000016_monitors_collection.sql
-- and 20260901000019_other_equipment_collection.sql.
--
-- Run inside a transaction:  begin; \i this file; -- verify --; commit;
-- Not placed in supabase/migrations/ on purpose — never auto-applied.
-- =========================================================================

-- --------------------------------------------------------- asset tables
create policy serialized_assets_insert on serialized_assets
  for insert with check (is_editor_or_admin() or my_role() = 'scanner');
create policy serialized_assets_update_editor on serialized_assets
  for update using (is_editor_or_admin()) with check (is_editor_or_admin());
create policy serialized_assets_delete_admin on serialized_assets
  for delete using (is_admin());

create policy active_laptops_np_insert on active_laptops_np
  for insert with check (is_editor_or_admin() or my_role() = 'scanner');
create policy active_laptops_np_update_editor on active_laptops_np
  for update using (is_editor_or_admin()) with check (is_editor_or_admin());
create policy active_laptops_np_delete_admin on active_laptops_np
  for delete using (is_admin());

create policy monitors_insert on monitors
  for insert with check (is_editor_or_admin() or my_role() = 'scanner');
create policy monitors_update_editor on monitors
  for update using (is_editor_or_admin()) with check (is_editor_or_admin());
create policy monitors_delete_admin on monitors
  for delete using (is_admin());

create policy other_equipment_insert on other_equipment
  for insert with check (is_editor_or_admin() or my_role() = 'scanner');
create policy other_equipment_update_editor on other_equipment
  for update using (is_editor_or_admin()) with check (is_editor_or_admin());
create policy other_equipment_delete_admin on other_equipment
  for delete using (is_admin());

-- ----------------------------------------------------------- bulk stock
create policy bulk_items_insert_editor on bulk_items
  for insert with check (is_editor_or_admin());
create policy bulk_items_update_editor on bulk_items
  for update using (is_editor_or_admin()) with check (is_editor_or_admin());
create policy bulk_items_delete_admin on bulk_items
  for delete using (is_admin());

-- -------------------------------------------------------------- history
create policy serialized_asset_history_insert_admin on serialized_asset_history
  for insert with check (is_admin());
create policy active_laptops_np_history_insert_admin on active_laptops_np_history
  for insert with check (is_admin());
create policy monitors_history_insert_admin on monitors_history
  for insert with check (is_admin());
create policy other_equipment_history_insert_admin on other_equipment_history
  for insert with check (is_admin());
create policy bulk_item_history_insert_admin on bulk_item_history
  for insert with check (is_admin());
