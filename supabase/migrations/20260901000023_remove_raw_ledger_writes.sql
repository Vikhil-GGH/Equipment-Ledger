-- =========================================================================
-- Ledger tables are written only through SECURITY DEFINER functions.
--
-- 20260901000007_rls_policies.sql (and 016/019 for Monitors/Other
-- Equipment) granted Editors raw INSERT/UPDATE, Scanners raw INSERT, and
-- Admins raw DELETE on every asset table and bulk_items, plus Admin raw
-- INSERT into every history table. None of those paths go through the
-- lifecycle state machine or write a history row, so they could change a
-- status, assignment, or serial with no audit trail — and DELETE cascades
-- an asset's entire history away.
--
-- The app never uses them: every asset/bulk mutation already goes through
-- create_asset / perform_lifecycle_action / perform_swap /
-- onboarding_assign_device / create_bulk_item / perform_bulk_action /
-- commit_*_import / restore_backup. Those run as the function owner and
-- bypass RLS, so dropping these policies doesn't affect them.
--
-- Unchanged: every SELECT policy, all profiles policies, and the
-- onboarding/offboarding checklist policies (the app does update those
-- tables directly). Manual data corrections remain possible from the SQL
-- editor (direct DB connection, not subject to RLS).
-- =========================================================================

-- --------------------------------------------------------- asset tables
drop policy serialized_assets_insert on serialized_assets;
drop policy serialized_assets_update_editor on serialized_assets;
drop policy serialized_assets_delete_admin on serialized_assets;

drop policy active_laptops_np_insert on active_laptops_np;
drop policy active_laptops_np_update_editor on active_laptops_np;
drop policy active_laptops_np_delete_admin on active_laptops_np;

drop policy monitors_insert on monitors;
drop policy monitors_update_editor on monitors;
drop policy monitors_delete_admin on monitors;

drop policy other_equipment_insert on other_equipment;
drop policy other_equipment_update_editor on other_equipment;
drop policy other_equipment_delete_admin on other_equipment;

-- ----------------------------------------------------------- bulk stock
drop policy bulk_items_insert_editor on bulk_items;
drop policy bulk_items_update_editor on bulk_items;
drop policy bulk_items_delete_admin on bulk_items;

-- -------------------------------------------------------------- history
-- History is written exclusively by the functions above.
drop policy serialized_asset_history_insert_admin on serialized_asset_history;
drop policy active_laptops_np_history_insert_admin on active_laptops_np_history;
drop policy monitors_history_insert_admin on monitors_history;
drop policy other_equipment_history_insert_admin on other_equipment_history;
drop policy bulk_item_history_insert_admin on bulk_item_history;
