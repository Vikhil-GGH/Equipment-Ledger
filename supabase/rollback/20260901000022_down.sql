-- =========================================================================
-- Rollback for 20260901000022_close_anonymous_access.sql
--
-- Restores the pre-022 definitions (helpers from
-- 20260901000005_role_helpers.sql, profiles update policy from
-- 20260901000007_rls_policies.sql, handle_new_user from
-- 20260901000017_anonymous_public_demo.sql).
--
-- One deliberate difference: 017 as written cannot insert a profile — its
-- CASE expression is text, not user_role, so every new auth user (anonymous
-- or real) fails with "column role is of type user_role but expression is
-- of type text". The handle_new_user restored below adds the ::user_role
-- cast so that rolling back can never break user creation. Before running
-- this, compare with the live definition:
--   select pg_get_functiondef('public.handle_new_user'::regproc);
--
-- WARNING: this re-opens anonymous access to the extent anonymous sign-ins
-- are still enabled on the project. Only run it if 022 itself is causing a
-- problem, and keep anonymous sign-ins disabled while it is rolled back.
--
-- Run inside a transaction:  begin; \i this file; -- verify --; commit;
-- Not placed in supabase/migrations/ on purpose — never auto-applied.
-- =========================================================================

drop trigger profiles_prevent_anonymous_privilege on profiles;
drop function prevent_anonymous_privilege();

drop policy profiles_update_admin_or_self on profiles;
create policy profiles_update_admin_or_self on profiles
  for update using (is_admin() or id = auth.uid())
  with check (is_admin() or id = auth.uid());

create or replace function my_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role from profiles where id = auth.uid()) = 'admin', false);
$$;

create or replace function is_editor_or_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
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
  select exists (select 1 from profiles where id = auth.uid());
$$;

drop function is_anonymous_session();

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, 'anonymous-' || new.id::text),
    new.raw_user_meta_data ->> 'full_name',
    (case when new.is_anonymous then 'editor' else 'viewer' end)::user_role
  );
  return new;
end;
$$;

-- Anonymous users' previous roles are NOT restored automatically — doing
-- so would hand the editor role back to every past demo visitor. If that
-- is genuinely required, it is one reviewed statement:
--
--   update profiles p set role = b.role
--   from private.anonymous_role_backup_022 b where b.id = p.id;
--
-- private.anonymous_role_backup_022 is left in place as an audit record.
