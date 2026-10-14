-- Applied right BEFORE 20260901000021_inventory_active_laptop_moves.sql, in
-- the same transaction, when rebuilding a database from the migration files.
--
-- 021 changes the return type of these two functions (void ->
-- asset_collection) with CREATE OR REPLACE, which Postgres rejects:
--   cannot change return type of existing function
-- Dropping them first lets 021's new definitions be created. Nothing else
-- depends on them (they are only called by the app), and they are
-- recreated by 021 in the same transaction.
drop function perform_lifecycle_action(asset_collection, uuid, asset_action, text, text);
drop function perform_swap(asset_collection, uuid, uuid, text);
