-- =========================================================================
-- Rollback for the PROPOSED 032 (supabase/proposals/032_auth_block_on_revoke.sql).
-- Restores the 030 functions exactly (copied from 20260901000030).
--
-- Deliberately NOT undone:
--   * sign-in blocks (auth.users.banned_until) on revoked accounts — lifting
--     them would let revoked people sign in again; restore each account, or
--     unban it in the Supabase dashboard, as a separate decision;
--   * the audit columns profile_access_history.auth_block / auth_error and
--     the 'auth_sync_retried' action — history is never rewritten;
--   * profiles.auth_blocked_by_revoke (kept so a later re-apply knows which
--     bans Remove access set).
-- =========================================================================
drop function auth_block_mismatches();
drop function retry_auth_sync(uuid);
drop function lift_auth_block(uuid);
drop function revoke_user_access(uuid, text);
drop function restore_user_access(uuid, text);
drop function apply_auth_block(uuid);

-- As in 20260901000030.
create or replace function keep_revoked_profile_viewer()
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

revoke execute on function revoke_user_access(uuid, text) from public, anon;
revoke execute on function restore_user_access(uuid, text) from public, anon;
grant execute on function revoke_user_access(uuid, text) to authenticated;
grant execute on function restore_user_access(uuid, text) to authenticated;
