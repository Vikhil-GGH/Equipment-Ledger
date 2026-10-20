-- =========================================================================
-- Access controls before production:
--
-- 1. Import History is written only by the import functions. The policy
--    that let an editor INSERT log rows directly (fake entries) is removed;
--    every real import already logs itself (commit_*_import, security
--    definer). Read access is unchanged.
--
-- 2. "Remove access" no longer deletes the profile (which history rows
--    reference as their actor — the delete failed, and must not succeed).
--    revoke_user_access() keeps the person's identity and audit trail:
--    the role becomes viewer (so every function that checks
--    profiles.role refuses them), the previous role is kept, and
--    is_known_user()/is_editor_or_admin()/is_admin() exclude revoked
--    accounts (so they read nothing). restore_user_access() puts the
--    previous role back. Both are admin-only, can't target yourself, never
--    remove the last admin, and are logged in profile_access_history.
--    A revoked account's role can't be raised without restoring it first,
--    and it can't edit even its own profile. The last active admin can't
--    be demoted or revoked. Deleting profiles is no longer allowed at all.
--
-- 3. MFA for administrative access: is_admin() — which gates role
--    changes, restore, access revocation and every admin-only policy —
--    now also requires a two-factor session (JWT "aal" = 'aal2'). An admin
--    signed in with only a password keeps editor-level access and can
--    enrol a TOTP factor (Supabase Auth), but cannot use admin powers
--    until verified. Direct database connections (no JWT) are unaffected.
--
-- Additive: no existing row or value changes. Rollback:
-- supabase/rollback/20260901000030_down.sql
-- =========================================================================

-- ---------------------------------------------------------- 1. import log
drop policy import_events_insert_editor on import_events;
revoke insert, update, delete, truncate on import_events from anon, authenticated;

-- ------------------------------------------------------ 2. access revoke
alter table profiles
  add column access_revoked_at timestamptz,
  add column access_revoked_by uuid references profiles (id),
  add column role_before_revoke user_role;

create table profile_access_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id),
  action text not null check (action in ('revoked', 'restored')),
  role_before user_role,
  role_after user_role,
  reason text,
  actor_user_id uuid references profiles (id),
  at timestamptz not null default clock_timestamp()
);
create index profile_access_history_user_idx on profile_access_history (user_id, at);
alter table profile_access_history enable row level security;
revoke insert, update, delete, truncate on profile_access_history from anon, authenticated;

-- The current session's assurance level ('aal1' password only, 'aal2' MFA).
create function current_aal()
returns text
language sql
stable
set search_path = public
as $$
  select coalesce(nullif(auth.jwt() ->> 'aal', ''), 'aal1');
$$;

create or replace function is_known_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not is_anonymous_session()
     and exists (select 1 from profiles where id = auth.uid() and access_revoked_at is null);
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
       (select role from profiles where id = auth.uid() and access_revoked_at is null) in ('admin', 'editor'),
       false
     );
$$;

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not is_anonymous_session()
     and current_aal() = 'aal2'
     and coalesce((select role from profiles where id = auth.uid() and access_revoked_at is null) = 'admin', false);
$$;

create policy profile_access_history_select_admin on profile_access_history for select using (is_admin());

-- A revoked account can't even edit its own row (it can't read it either).
drop policy profiles_update_admin_or_self on profiles;
create policy profiles_update_admin_or_self on profiles
  for update using ((is_admin() or (id = auth.uid() and is_known_user())) and not is_anonymous_session())
  with check ((is_admin() or (id = auth.uid() and is_known_user())) and not is_anonymous_session());

-- The last active admin can't be demoted (nor revoked — see below), so the
-- system always keeps someone who can manage roles and restore access.
create function keep_one_active_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role = 'admin' and old.access_revoked_at is null
     and (new.role <> 'admin' or new.access_revoked_at is not null)
     and not exists (select 1 from profiles where role = 'admin' and access_revoked_at is null and id <> old.id) then
    raise exception 'This is the last active admin — make someone else an admin first' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger profiles_keep_one_active_admin
  before update on profiles
  for each row execute function keep_one_active_admin();

-- Deleting a profile would orphan (or block on) every history row it
-- authored; access is revoked instead.
drop policy profiles_delete_admin on profiles;
revoke delete, truncate on profiles from anon, authenticated;

create function keep_revoked_profile_viewer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.access_revoked_at is not null and new.role <> 'viewer'
     and not coalesce(nullif(current_setting('equipment.restoring_access', true), ''), '') = 'on' then
    raise exception 'This account''s access is removed — restore access first' using errcode = 'check_violation';
  end if;
  if (new.access_revoked_at is distinct from old.access_revoked_at or new.role_before_revoke is distinct from old.role_before_revoke
      or new.access_revoked_by is distinct from old.access_revoked_by)
     and auth.uid() is not null
     and not coalesce(nullif(current_setting('equipment.restoring_access', true), ''), '') = 'on' then
    raise exception 'Use Remove access / Restore access to change access';
  end if;
  return new;
end;
$$;
create trigger profiles_keep_revoked_viewer
  before update on profiles
  for each row execute function keep_revoked_profile_viewer();

create function revoke_user_access(p_user_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target profiles;
begin
  if not is_admin() then
    raise exception 'Only an admin (signed in with two-factor authentication) can remove access';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'You cannot remove your own access';
  end if;
  select * into v_target from profiles where id = p_user_id for update;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.access_revoked_at is not null then
    raise exception 'This user''s access is already removed';
  end if;
  if v_target.role = 'admin' and not exists (
    select 1 from profiles where role = 'admin' and access_revoked_at is null and id <> p_user_id
  ) then
    raise exception 'This is the last admin — make someone else an admin first';
  end if;
  perform set_config('equipment.restoring_access', 'on', true);
  update profiles
     set role_before_revoke = v_target.role, role = 'viewer', access_revoked_at = now(), access_revoked_by = auth.uid()
   where id = p_user_id;
  perform set_config('equipment.restoring_access', '', true);
  insert into profile_access_history (user_id, action, role_before, role_after, reason, actor_user_id)
  values (p_user_id, 'revoked', v_target.role, 'viewer', nullif(btrim(coalesce(p_reason, '')), ''), auth.uid());
end;
$$;

create function restore_user_access(p_user_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target profiles;
  v_role user_role;
begin
  if not is_admin() then
    raise exception 'Only an admin (signed in with two-factor authentication) can restore access';
  end if;
  select * into v_target from profiles where id = p_user_id for update;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.access_revoked_at is null then
    raise exception 'This user already has access';
  end if;
  v_role := coalesce(v_target.role_before_revoke, 'viewer');
  perform set_config('equipment.restoring_access', 'on', true);
  update profiles
     set role = v_role, access_revoked_at = null, access_revoked_by = null, role_before_revoke = null
   where id = p_user_id;
  perform set_config('equipment.restoring_access', '', true);
  insert into profile_access_history (user_id, action, role_before, role_after, reason, actor_user_id)
  values (p_user_id, 'restored', 'viewer', v_role, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid());
end;
$$;

revoke execute on function keep_revoked_profile_viewer() from public, anon, authenticated;
revoke execute on function keep_one_active_admin() from public, anon, authenticated;
revoke execute on function revoke_user_access(uuid, text) from public, anon;
revoke execute on function restore_user_access(uuid, text) from public, anon;
grant execute on function revoke_user_access(uuid, text) to authenticated;
grant execute on function restore_user_access(uuid, text) to authenticated;
