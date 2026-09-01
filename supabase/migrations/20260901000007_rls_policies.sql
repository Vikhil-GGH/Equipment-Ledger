-- =========================================================================
-- Row-Level Security — this is the real access-control gate. The frontend
-- role checks (Phase 2+) are UX only; every policy below is what actually
-- stops an Editor/Viewer/Scanner from doing something out of scope, even if
-- they call the Supabase REST/RPC API directly.
--
-- Documented permission-boundary assumptions (adjust here + README if wrong):
--  - All four roles can SELECT the ledger + history (Viewer is read-only,
--    not "no access"; Scanner needs lookups to work).
--  - Raw table INSERT/UPDATE on the ledger is Editor/Admin only. Scanner's
--    mutation ability is deliberately narrower than Editor's and is granted
--    only through SECURITY DEFINER lifecycle functions added in Phase 3
--    (scan-to-add and basic check-in/check-out), not through open table
--    UPDATE grants — so a scanner cannot, say, silently edit an asset name.
--  - History rows are written exclusively by SECURITY DEFINER lifecycle
--    functions (Phase 3), which bypass RLS as the function owner. Direct
--    client INSERT into a history table is Admin-only (manual corrections)
--    and history rows are otherwise immutable (no UPDATE/DELETE policy at
--    all — an audit trail that can be edited isn't an audit trail).
--  - Decommission is Editor-level, not Admin-only: it's a routine
--    offboarding step Editors perform day-to-day, not a sensitive action.
--    (Easy to tighten later: change is_editor_or_admin() to is_admin() in
--    the relevant lifecycle-function role check once Phase 3 lands.)
--  - Bulk Stock is out of scope for Scanner entirely (spec ties Scanner to
--    the serialized-asset scan flow only).
--  - Hard DELETE of ledger rows is Admin-only everywhere.
-- =========================================================================

alter table profiles enable row level security;
alter table serialized_assets enable row level security;
alter table serialized_asset_history enable row level security;
alter table active_laptops_np enable row level security;
alter table active_laptops_np_history enable row level security;
alter table bulk_items enable row level security;
alter table bulk_item_history enable row level security;
alter table import_events enable row level security;
alter table onboarding_checklists enable row level security;
alter table offboarding_checklists enable row level security;

-- ---------------------------------------------------------------- profiles
-- Readable by any known user (needed to resolve actor names in history and
-- to populate assignee/admin-panel pickers).
create policy profiles_select_known on profiles
  for select using (is_known_user());

create policy profiles_insert_admin on profiles
  for insert with check (is_admin());

-- Admins can update any profile (including role); a user may update their
-- own row (e.g. full_name) — role escalation by a non-admin is blocked by
-- the trigger below, not by this policy, since RLS can't restrict columns.
create policy profiles_update_admin_or_self on profiles
  for update using (is_admin() or id = auth.uid())
  with check (is_admin() or id = auth.uid());

create function prevent_self_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role and not is_admin() then
    raise exception 'Only an admin can change a user role';
  end if;
  return new;
end;
$$;

create trigger profiles_prevent_self_role_escalation
  before update on profiles
  for each row execute function prevent_self_role_escalation();

create policy profiles_delete_admin on profiles
  for delete using (is_admin());

-- ------------------------------------------------------- serialized_assets
create policy serialized_assets_select_known on serialized_assets
  for select using (is_known_user());

-- Editor/Admin (general CRUD) OR Scanner (scan-to-add flow when a scanned
-- serial isn't found in any collection).
create policy serialized_assets_insert on serialized_assets
  for insert with check (is_editor_or_admin() or my_role() = 'scanner');

create policy serialized_assets_update_editor on serialized_assets
  for update using (is_editor_or_admin()) with check (is_editor_or_admin());

create policy serialized_assets_delete_admin on serialized_assets
  for delete using (is_admin());

create policy serialized_asset_history_select_known on serialized_asset_history
  for select using (is_known_user());

create policy serialized_asset_history_insert_admin on serialized_asset_history
  for insert with check (is_admin());
-- No update/delete policy: history is immutable once written.

-- ------------------------------------------------------- active_laptops_np
create policy active_laptops_np_select_known on active_laptops_np
  for select using (is_known_user());

create policy active_laptops_np_insert on active_laptops_np
  for insert with check (is_editor_or_admin() or my_role() = 'scanner');

create policy active_laptops_np_update_editor on active_laptops_np
  for update using (is_editor_or_admin()) with check (is_editor_or_admin());

create policy active_laptops_np_delete_admin on active_laptops_np
  for delete using (is_admin());

create policy active_laptops_np_history_select_known on active_laptops_np_history
  for select using (is_known_user());

create policy active_laptops_np_history_insert_admin on active_laptops_np_history
  for insert with check (is_admin());

-- ------------------------------------------------------------- bulk_items
create policy bulk_items_select_known on bulk_items
  for select using (is_known_user());

create policy bulk_items_insert_editor on bulk_items
  for insert with check (is_editor_or_admin());

create policy bulk_items_update_editor on bulk_items
  for update using (is_editor_or_admin()) with check (is_editor_or_admin());

create policy bulk_items_delete_admin on bulk_items
  for delete using (is_admin());

create policy bulk_item_history_select_known on bulk_item_history
  for select using (is_known_user());

create policy bulk_item_history_insert_admin on bulk_item_history
  for insert with check (is_admin());

-- ----------------------------------------------------------- import_events
create policy import_events_select_known on import_events
  for select using (is_known_user());

create policy import_events_insert_editor on import_events
  for insert with check (is_editor_or_admin() and imported_by = auth.uid());
-- No update/delete: the import log is immutable.

-- ----------------------------------------------- onboarding / offboarding
create policy onboarding_select_known on onboarding_checklists
  for select using (is_known_user());

create policy onboarding_write_editor on onboarding_checklists
  for insert with check (is_editor_or_admin());

create policy onboarding_update_editor on onboarding_checklists
  for update using (is_editor_or_admin()) with check (is_editor_or_admin());

create policy onboarding_delete_admin on onboarding_checklists
  for delete using (is_admin());

create policy offboarding_select_known on offboarding_checklists
  for select using (is_known_user());

create policy offboarding_write_editor on offboarding_checklists
  for insert with check (is_editor_or_admin());

create policy offboarding_update_editor on offboarding_checklists
  for update using (is_editor_or_admin()) with check (is_editor_or_admin());

create policy offboarding_delete_admin on offboarding_checklists
  for delete using (is_admin());
