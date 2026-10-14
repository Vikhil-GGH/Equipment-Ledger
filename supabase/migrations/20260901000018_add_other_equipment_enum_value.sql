-- Other Equipment becomes its own top-level asset collection, same pattern
-- as Monitors (20260901000015/16). Split into its own migration file:
-- ALTER TYPE ... ADD VALUE must commit before the new value can be
-- referenced by name elsewhere.
alter type asset_collection add value 'other_equipment';
