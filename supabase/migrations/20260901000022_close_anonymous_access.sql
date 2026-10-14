-- =========================================================================
-- Close anonymous access (reverses the temporary public-demo mode from
-- 20260901000017_anonymous_public_demo.sql).
--
-- Goal: an anonymous Supabase session has NO effective read or write
-- permission anywhere, independent of whatever profiles row it has. Three
-- independent layers, each sufficient on its own for its half:
--
--   1. Reads + RLS-gated writes: every role helper used by RLS policies
--      (is_known_user, is_admin, is_editor_or_admin, my_role) now returns
--      false/null for an anonymous session, so every SELECT/INSERT/UPDATE/
--      DELETE policy denies it — including on profiles itself.
--   2. RPC writes: the SECURITY DEFINER lifecycle/import/bulk/onboarding
--      functions read the caller's role straight from profiles rather than
--      through the helpers, so an anonymous profile is pinned to 'viewer'
--      (which every one of those functions rejects) by a trigger that
--      refuses any other role for an anonymous user. restore_backup goes
--      through is_admin() and is covered by layer 1.
--   3. New anonymous users get no profiles row at all.
--
-- Existing auth sessions are NOT touched (no writes to the auth schema):
-- they stay valid but carry no permissions. Existing anonymous auth.users
-- and profiles rows are kept so every actor_user_id / created_by /
-- imported_by audit reference stays intact. The only data change is the
-- role column of anonymous users' profiles rows, and their previous values
-- are saved in private.anonymous_role_backup_022 for rollback/audit.
-- =========================================================================

-- ------------------------------------------------- is the caller anonymous?
-- Checks the JWT claim AND the auth.users row: either alone is enough to
-- classify a session as anonymous, so a token minted without the claim
-- still can't slip through. Direct database connections (SQL editor,
-- migrations) have no auth.uid() and are never anonymous.
create function is_anonymous_session()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
      or coalesce((select u.is_anonymous from auth.users u where u.id = auth.uid()), false);
$$;

-- ------------------------------------------- layer 1: role helpers for RLS
create or replace function my_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid() and not is_anonymous_session();
$$;

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

-- profiles_update_admin_or_self let any user update their own row; an
-- anonymous session must not be able to touch even its own profile.
drop policy profiles_update_admin_or_self on profiles;
create policy profiles_update_admin_or_self on profiles
  for update using ((is_admin() or id = auth.uid()) and not is_anonymous_session())
  with check ((is_admin() or id = auth.uid()) and not is_anonymous_session());

-- ------------------------------------------- layer 2: pin anonymous to viewer
create function prevent_anonymous_privilege()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role <> 'viewer'
     and exists (select 1 from auth.users u where u.id = new.id and u.is_anonymous) then
    raise exception 'Anonymous users cannot be granted the % role', new.role;
  end if;
  return new;
end;
$$;

create trigger profiles_prevent_anonymous_privilege
  before insert or update on profiles
  for each row execute function prevent_anonymous_privilege();

-- Save the current roles of anonymous users before pinning them, in a
-- schema the Data API does not expose (only public/graphql_public are).
create schema if not exists private;
revoke all on schema private from public;

-- "if not exists" + insert (not CREATE TABLE AS) so the migration can be
-- re-applied after its rollback script without failing; the rollback
-- deliberately keeps this table as an audit record.
create table if not exists private.anonymous_role_backup_022 (
  id uuid not null,
  role user_role not null,
  captured_at timestamptz not null default now()
);

insert into private.anonymous_role_backup_022 (id, role)
  select p.id, p.role
  from profiles p
  join auth.users u on u.id = p.id
  where u.is_anonymous;

update profiles p
  set role = 'viewer'
  from auth.users u
  where u.id = p.id and u.is_anonymous and p.role <> 'viewer';

-- --------------------------------------- layer 3: no profile for new anons
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_anonymous then
    return new;
  end if;

  insert into profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;
