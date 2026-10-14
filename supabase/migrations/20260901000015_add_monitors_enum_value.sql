-- Monitors becomes its own top-level asset collection (previously folded
-- into Serialized Assets since there was nowhere else to put it). Split
-- into its own migration file: ALTER TYPE ... ADD VALUE must commit before
-- the new value can be referenced by name elsewhere.
alter type asset_collection add value 'monitors';
