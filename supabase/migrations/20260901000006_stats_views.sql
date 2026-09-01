-- Dashboard stat views: computed live from the tables on every read, so
-- imports/lifecycle actions can never desync from what the dashboard shows
-- (no denormalized counters to remember to refresh).
-- security_invoker = true: without it, Postgres views run permission checks
-- as the view OWNER (not the querying user), which can silently bypass RLS
-- on the underlying tables. Not exploitable today (every role can already
-- SELECT the full ledger), but pinned explicitly so it stays correct if a
-- row-restrictive SELECT policy is ever added later.
create view serialized_assets_stats
  with (security_invoker = true) as
select status, count(*) as count
from serialized_assets
group by status;

create view active_laptops_np_stats
  with (security_invoker = true) as
select status, count(*) as count
from active_laptops_np
group by status;

create view bulk_stock_stats
  with (security_invoker = true) as
select
  coalesce(sum(available), 0) as available,
  coalesce(sum(provided), 0) as provided,
  coalesce(sum(retained), 0) as retained,
  coalesce(sum(damaged), 0) as damaged,
  coalesce(sum(decommissioned), 0) as decommissioned
from bulk_items;
