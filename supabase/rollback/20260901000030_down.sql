-- =========================================================================
-- Rollback for 20260901000030_access_controls.sql
--
-- Restores is_known_user / is_editor_or_admin / is_admin exactly as
-- 20260901000022 left them (no MFA requirement), the editor INSERT policy
-- on import_events and the admin DELETE policy on profiles (both as in
-- 20260901000007), and removes access revocation.
--
-- Refuses to run while any account's access is revoked: dropping the
-- revocation would silently turn that person back into a viewer who can
-- read the ledger. Restore (or decide about) those accounts first.
-- The access history is copied to private.profile_access_history_backup_030.
--
-- Run BEFORE 20260901000029_down.sql, inside a transaction.
-- Not in supabase/migrations/ — never auto-applied.
-- =========================================================================
do $$
begin
  if exists (select 1 from profiles where access_revoked_at is not null) then
    raise exception 'Rollback stopped: % account(s) have access removed. Restore or resolve them first — rolling back would give them read access again.',
      (select count(*) from profiles where access_revoked_at is not null);
  end if;
end $$;

create schema if not exists private;
create table if not exists private.profile_access_history_backup_030 as
  select now() as backed_up_at, h.id, h.user_id, h.action, h.role_before::text as role_before, h.role_after::text as role_after,
         h.reason, h.actor_user_id, h.at
  from profile_access_history h limit 0;
insert into private.profile_access_history_backup_030
  select now(), h.id, h.user_id, h.action, h.role_before::text, h.role_after::text, h.reason, h.actor_user_id, h.at from profile_access_history h;

drop function revoke_user_access(uuid, text);
drop function restore_user_access(uuid, text);
drop trigger profiles_keep_revoked_viewer on profiles;
drop function keep_revoked_profile_viewer();
drop trigger profiles_keep_one_active_admin on profiles;
drop function keep_one_active_admin();
-- As in 20260901000022.
drop policy profiles_update_admin_or_self on profiles;
create policy profiles_update_admin_or_self on profiles
  for update using ((is_admin() or id = auth.uid()) and not is_anonymous_session())
  with check ((is_admin() or id = auth.uid()) and not is_anonymous_session());
drop policy profile_access_history_select_admin on profile_access_history;
drop table profile_access_history;

-- As in 20260901000022.
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not is_anonymous_session()
     and coalesce((select role from profiles where id = auth.uid()) = 'admin', false);
$$;

create or replace function is_editor_or_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not is_anonymous_session()
     and coalesce(
       (select role from profiles where id = auth.uid()) in ('admin', 'editor'),
       false
     );
$$;

create or replace function is_known_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not is_anonymous_session()
     and exists (select 1 from profiles where id = auth.uid());
$$;

drop function current_aal();

alter table profiles
  drop column access_revoked_at,
  drop column access_revoked_by,
  drop column role_before_revoke;

-- As in 20260901000007.
grant delete, truncate on profiles to anon, authenticated;
create policy profiles_delete_admin on profiles
  for delete using (is_admin());
grant insert, update, delete, truncate on import_events to anon, authenticated;
create policy import_events_insert_editor on import_events
  for insert with check (is_editor_or_admin() and imported_by = auth.uid());
