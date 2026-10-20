-- =========================================================================
-- PROPOSAL — NOT A MIGRATION. Not in supabase/migrations/; never applied by
-- any tool. Builds on 030 (and works with or without the proposed 031).
--
-- Remove access also blocks SIGN-IN, in the same transaction:
--   * auth.users.banned_until is set ~100 years ahead (what Supabase's own
--     "ban" does), so Supabase Auth refuses password sign-in AND token
--     refresh;
--   * every Auth session is deleted (refresh tokens cascade), so every
--     device is signed out. Access tokens already issued stay valid until
--     they expire (≤ 1 hour), but grant nothing: the database checks the
--     revoked state on every request (030).
-- Restore access lifts the block — but only a block that Remove access set.
-- A ban applied separately (dashboard) is left alone and reported.
--
-- Failure handling: blocking sign-in is a second layer. If that step fails
-- (e.g. Supabase changes its Auth tables), the revoke STILL happens — data
-- access is what matters most — and the failure is recorded on the history
-- row (auth_block = 'failed', auth_error) and shown in the app.
-- retry_auth_sync() repairs it; auth_block_mismatches() lists every
-- account whose Auth state disagrees with its access state, for staging
-- verify, the production smoke check and periodic review.
--
-- Rollback: supabase/proposals/032_down.sql. It restores the 030 functions
-- and deliberately leaves every sign-in block in place (lifting them would
-- let revoked people sign in again) and keeps the audit columns.
-- =========================================================================

alter table profiles add column auth_blocked_by_revoke boolean not null default false;
alter table profile_access_history
  add column auth_block text check (auth_block in ('applied', 'lifted', 'failed', 'not_ours', 'none')),
  add column auth_error text;
alter table profile_access_history drop constraint profile_access_history_action_check;
alter table profile_access_history add constraint profile_access_history_action_check
  check (action in ('revoked', 'restored', 'auth_sync_retried'));

-- The access fields may only change through the functions (as in 030).
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
      or new.access_revoked_by is distinct from old.access_revoked_by or new.auth_blocked_by_revoke is distinct from old.auth_blocked_by_revoke)
     and auth.uid() is not null
     and not coalesce(nullif(current_setting('equipment.restoring_access', true), ''), '') = 'on' then
    raise exception 'Use Remove access / Restore access to change access';
  end if;
  return new;
end;
$$;

-- Block sign-in and end every session. Returns 'applied', 'not_ours' (already
-- banned some other way — left as it is; sessions still ended) or
-- 'failed: <error>'. Runs in its own subtransaction: a failure never undoes
-- the caller's work.
create function apply_auth_block(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_already boolean;
begin
  select coalesce(banned_until > now(), false) into v_already from auth.users where id = p_user_id;
  if not v_already then
    update auth.users set banned_until = now() + interval '100 years' where id = p_user_id;
  end if;
  delete from auth.sessions where user_id = p_user_id; -- refresh tokens cascade
  return case when v_already then 'not_ours' else 'applied' end;
exception when others then
  return 'failed: ' || sqlerrm;
end;
$$;

-- Lift a block that Remove access set. Returns 'lifted' or 'failed: <error>'.
create function lift_auth_block(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  update auth.users set banned_until = null where id = p_user_id;
  return 'lifted';
exception when others then
  return 'failed: ' || sqlerrm;
end;
$$;

-- The return type changes (void -> jsonb: the app shows whether sign-in was blocked).
drop function revoke_user_access(uuid, text);
create function revoke_user_access(p_user_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target profiles;
  v_block text;
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
  v_block := apply_auth_block(p_user_id);
  perform set_config('equipment.restoring_access', 'on', true);
  update profiles
     set role_before_revoke = v_target.role, role = 'viewer', access_revoked_at = now(), access_revoked_by = auth.uid(),
         auth_blocked_by_revoke = (v_block = 'applied')
   where id = p_user_id;
  perform set_config('equipment.restoring_access', '', true);
  insert into profile_access_history (user_id, action, role_before, role_after, reason, actor_user_id, auth_block, auth_error)
  values (p_user_id, 'revoked', v_target.role, 'viewer', nullif(btrim(coalesce(p_reason, '')), ''), auth.uid(),
          split_part(v_block, ':', 1), nullif(substr(v_block, length(split_part(v_block, ':', 1)) + 3), ''));
  return jsonb_build_object('sign_in_blocked', v_block in ('applied', 'not_ours'), 'auth_block', split_part(v_block, ':', 1));
end;
$$;

drop function restore_user_access(uuid, text);
create function restore_user_access(p_user_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target profiles;
  v_role user_role;
  v_block text := 'none';
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
  -- Lift only the block Remove access set; a separate (dashboard) ban stays.
  if v_target.auth_blocked_by_revoke then
    v_block := lift_auth_block(p_user_id);
  elsif exists (select 1 from auth.users where id = p_user_id and banned_until > now()) then
    v_block := 'not_ours';
  end if;
  v_role := coalesce(v_target.role_before_revoke, 'viewer');
  perform set_config('equipment.restoring_access', 'on', true);
  update profiles
     set role = v_role, access_revoked_at = null, access_revoked_by = null, role_before_revoke = null,
         auth_blocked_by_revoke = (v_block like 'failed%')
   where id = p_user_id;
  perform set_config('equipment.restoring_access', '', true);
  insert into profile_access_history (user_id, action, role_before, role_after, reason, actor_user_id, auth_block, auth_error)
  values (p_user_id, 'restored', 'viewer', v_role, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid(),
          split_part(v_block, ':', 1), nullif(substr(v_block, length(split_part(v_block, ':', 1)) + 3), ''));
  return jsonb_build_object('sign_in_unblocked', v_block in ('lifted', 'none'), 'auth_block', split_part(v_block, ':', 1));
end;
$$;

-- Bring one account's Auth state in line with its access state after a
-- failure: revoked → block sign-in; restored but still blocked by Remove
-- access → lift it. Admin only, audited.
create function retry_auth_sync(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target profiles;
  v_block text;
begin
  if not is_admin() then
    raise exception 'Only an admin (signed in with two-factor authentication) can do this';
  end if;
  select * into v_target from profiles where id = p_user_id for update;
  if v_target.id is null then
    raise exception 'User not found';
  end if;
  if v_target.access_revoked_at is not null then
    v_block := apply_auth_block(p_user_id);
  elsif v_target.auth_blocked_by_revoke then
    v_block := lift_auth_block(p_user_id);
  else
    raise exception 'Nothing to fix for this account';
  end if;
  perform set_config('equipment.restoring_access', 'on', true);
  update profiles
     set auth_blocked_by_revoke = case when v_block = 'applied' then true when v_block = 'lifted' then false else auth_blocked_by_revoke end
   where id = p_user_id;
  perform set_config('equipment.restoring_access', '', true);
  insert into profile_access_history (user_id, action, role_before, role_after, actor_user_id, auth_block, auth_error)
  values (p_user_id, 'auth_sync_retried', v_target.role, v_target.role, auth.uid(),
          split_part(v_block, ':', 1), nullif(substr(v_block, length(split_part(v_block, ':', 1)) + 3), ''));
  return jsonb_build_object('auth_block', split_part(v_block, ':', 1));
end;
$$;

-- Accounts whose Auth state disagrees with their access state. Admin only.
create function auth_block_mismatches()
returns table (user_id uuid, email text, problem text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.email,
         case when p.access_revoked_at is not null and coalesce(u.banned_until, '-infinity') <= now() then 'access removed, but can still sign in'
              when p.access_revoked_at is null and p.auth_blocked_by_revoke then 'access restored, but sign-in is still blocked'
              when p.access_revoked_at is not null and exists (select 1 from auth.sessions s where s.user_id = p.id) then 'access removed, but has Auth sessions'
         end
  from profiles p join auth.users u on u.id = p.id
  where is_admin()
    and ((p.access_revoked_at is not null and coalesce(u.banned_until, '-infinity') <= now())
      or (p.access_revoked_at is null and p.auth_blocked_by_revoke)
      or (p.access_revoked_at is not null and exists (select 1 from auth.sessions s where s.user_id = p.id)));
$$;

revoke execute on function apply_auth_block(uuid) from public, anon, authenticated;
revoke execute on function lift_auth_block(uuid) from public, anon, authenticated;
revoke execute on function retry_auth_sync(uuid) from public, anon;
revoke execute on function auth_block_mismatches() from public, anon;
grant execute on function retry_auth_sync(uuid) to authenticated;
grant execute on function auth_block_mismatches() to authenticated;
revoke execute on function revoke_user_access(uuid, text) from public, anon;
revoke execute on function restore_user_access(uuid, text) from public, anon;
grant execute on function revoke_user_access(uuid, text) to authenticated;
grant execute on function restore_user_access(uuid, text) to authenticated;
