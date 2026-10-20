-- =========================================================================
-- PROPOSAL — NOT A MIGRATION. Not in supabase/migrations/; never applied by
-- any tool. Requires 030 and 031.
--
-- Revoked accounts also lose the ability to SIGN IN, through the supported
-- Supabase Auth Admin API (never by writing Supabase's auth tables).
--
-- Design (outbox):
--   * Remove / Restore access work exactly as in 030 — data access changes
--     at once, in the database, whatever happens to Auth.
--   * A trigger on that change records the account in auth_sync_state
--     ("needs syncing") and appends an auth_sync_events entry, in the same
--     transaction.
--   * The auth-sync Edge Function (server side; the service-role key never
--     leaves Supabase) claims pending accounts, recomputes what the account
--     SHOULD be from profiles (the source of truth — never a queued
--     instruction), bans or unbans through the Admin API, and reports back.
--   * It only ever lifts a ban it applied itself (and only if that ban is
--     still exactly as it set it); any other ban is left alone and
--     recorded as "not ours".
--   * Failures are recorded with the error, retried with backoff, and every
--     run first reconciles: any account whose sign-in state could disagree
--     with its access state is queued again.
--   * Nothing here can change profiles: a failed ban or unban can never
--     grant data access (data access is decided by profiles alone, 030/031).
--
-- Rollback: supabase/proposals/032_down.sql (keeps the audit trail).
-- =========================================================================

create table auth_sync_state (
  user_id uuid primary key references profiles (id),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'synced', 'failed', 'not_ours')),
  lease_until timestamptz,                        -- in_progress: claimed by a worker until then
  ban_owned boolean not null default false,       -- a ban this sync applied and may lift
  ban_until_set timestamptz,                      -- exactly what it set (lift only if unchanged)
  attempts int not null default 0,
  last_attempt_at timestamptz,
  last_error text,
  requested_at timestamptz not null default clock_timestamp(),
  synced_at timestamptz,
  synced_state text check (synced_state in ('blocked', 'unblocked'))
);
create table auth_sync_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id),
  at timestamptz not null default clock_timestamp(),
  kind text not null check (kind in ('requested', 'retry_requested', 'reconciled', 'blocked', 'unblocked', 'already', 'not_ours', 'failed', 'superseded')),
  desired text check (desired in ('blocked', 'unblocked')),
  detail text,
  error text,
  attempt int,
  actor_user_id uuid references profiles (id)    -- who caused it (null = the sync service)
);
create index auth_sync_events_user_idx on auth_sync_events (user_id, at);
alter table auth_sync_state enable row level security;
alter table auth_sync_events enable row level security;
create policy auth_sync_state_select_admin on auth_sync_state for select using (is_admin());
create policy auth_sync_events_select_admin on auth_sync_events for select using (is_admin());
revoke insert, update, delete, truncate on auth_sync_state, auth_sync_events from anon, authenticated;

-- What the account's sign-in state SHOULD be, from the source of truth.
create function auth_sync_desired(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when access_revoked_at is not null then 'blocked' else 'unblocked' end from profiles where id = p_user_id;
$$;

-- Remove / Restore access (or any change of the access state) queues a sync.
create function queue_auth_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.access_revoked_at is distinct from old.access_revoked_at then
    insert into auth_sync_state (user_id, status, requested_at, attempts, last_error)
    values (new.id, 'pending', clock_timestamp(), 0, null)
    on conflict (user_id) do update set status = 'pending', requested_at = clock_timestamp(), attempts = 0, last_error = null;
    insert into auth_sync_events (user_id, kind, desired, actor_user_id)
    values (new.id, 'requested', case when new.access_revoked_at is not null then 'blocked' else 'unblocked' end, auth.uid());
  end if;
  return new;
end;
$$;
create trigger profiles_queue_auth_sync
  after update of access_revoked_at on profiles
  for each row execute function queue_auth_sync();

-- ------------------------------------------------ service side (service_role only)

-- Queue every account whose sign-in state could disagree with its access
-- state: revoked but not synced as blocked; active but holding a ban this
-- sync applied; and, once a day, every revoked account again (a ban lifted
-- in the dashboard, or an unrelated ban that expired, is caught and the
-- account blocked again). Returns how many were queued.
create function auth_sync_reconcile()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int := 0;
  r record;
begin
  for r in
    select p.id, auth_sync_desired(p.id) as desired
    from profiles p left join auth_sync_state s on s.user_id = p.id
    where coalesce(s.status, '') not in ('pending', 'failed', 'in_progress') -- failed / in_progress: handled by auth_sync_claim
      and ((p.access_revoked_at is not null and (s.user_id is null or s.status not in ('synced', 'not_ours') or s.synced_state is distinct from 'blocked'
                                                  or s.synced_at < clock_timestamp() - interval '1 day'))
        or (p.access_revoked_at is null and s.ban_owned))
  loop
    insert into auth_sync_state (user_id, status, requested_at) values (r.id, 'pending', clock_timestamp())
    on conflict (user_id) do update set status = 'pending', requested_at = clock_timestamp();
    insert into auth_sync_events (user_id, kind, desired, detail) values (r.id, 'reconciled', r.desired, 'state could disagree with access');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- Claim up to p_limit accounts to sync now: pending ones, failed ones whose
-- backoff (2^attempts minutes, at most 60) has passed, and in_progress ones
-- whose worker's lease expired (it crashed). A claim takes a 5-minute lease
-- (status in_progress), so two workers never sync the same account at once —
-- the row lock alone would end when this call's transaction commits.
create function auth_sync_claim(p_limit int default 25)
returns table (user_id uuid, desired text, ban_owned boolean, ban_until_set timestamptz, attempts int)
language sql
security definer
set search_path = public
as $$
  with c as (
    select s.user_id from auth_sync_state s
    where s.status = 'pending'
       or (s.status = 'failed' and s.last_attempt_at < clock_timestamp() - least(power(2, s.attempts), 60) * interval '1 minute')
       or (s.status = 'in_progress' and s.lease_until < clock_timestamp())
    order by s.requested_at
    limit p_limit
    for update skip locked
  )
  update auth_sync_state s set status = 'in_progress', lease_until = clock_timestamp() + interval '5 minutes',
         last_attempt_at = clock_timestamp(), attempts = s.attempts + 1
  from c where s.user_id = c.user_id
  returning s.user_id, auth_sync_desired(s.user_id), s.ban_owned, s.ban_until_set, s.attempts;
$$;

-- Report the outcome for one account. p_result: 'blocked' | 'unblocked' |
-- 'already' | 'not_ours' | 'failed'. If the access state changed while the
-- worker was busy (p_desired no longer matches), the account stays queued.
create function auth_sync_report(p_user_id uuid, p_desired text, p_result text, p_ban_owned boolean, p_ban_until_set timestamptz, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt int;
begin
  if p_result not in ('blocked', 'unblocked', 'already', 'not_ours', 'failed') then
    raise exception 'Unknown result %', p_result;
  end if;
  select attempts into v_attempt from auth_sync_state where user_id = p_user_id for update;
  if not found then
    raise exception 'No sync state for %', p_user_id;
  end if;
  if p_result <> 'failed' then
    -- What Auth now holds is recorded even if the access state moved on meanwhile.
    update auth_sync_state set ban_owned = p_ban_owned, ban_until_set = p_ban_until_set where user_id = p_user_id;
  end if;
  insert into auth_sync_events (user_id, kind, desired, error, attempt, detail)
  values (p_user_id, p_result, p_desired, p_error, v_attempt,
          case when p_result = 'not_ours' then 'an existing ban not applied by this sync — left as it is' end);
  update auth_sync_state set lease_until = null where user_id = p_user_id;
  if auth_sync_desired(p_user_id) is distinct from p_desired then
    update auth_sync_state set status = 'pending', last_error = null where user_id = p_user_id;
    insert into auth_sync_events (user_id, kind, desired, detail) values (p_user_id, 'superseded', auth_sync_desired(p_user_id), 'access changed during the sync — queued again');
  elsif p_result = 'failed' then
    update auth_sync_state set status = 'failed', last_error = p_error where user_id = p_user_id;
  else
    update auth_sync_state set status = case when p_result = 'not_ours' then 'not_ours' else 'synced' end,
           synced_state = p_desired, synced_at = clock_timestamp(), last_error = null
     where user_id = p_user_id;
  end if;
end;
$$;

-- ------------------------------------------------ admin side (two-factor admins)

-- Ask for an immediate retry (the app then calls the Edge Function).
create function request_auth_sync_retry(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Only an admin (signed in with two-factor authentication) can do this';
  end if;
  insert into auth_sync_state (user_id, status, requested_at) values (p_user_id, 'pending', clock_timestamp())
  on conflict (user_id) do update set status = 'pending', requested_at = clock_timestamp(), attempts = 0;
  insert into auth_sync_events (user_id, kind, desired, actor_user_id) values (p_user_id, 'retry_requested', auth_sync_desired(p_user_id), auth.uid());
end;
$$;

revoke execute on function auth_sync_desired(uuid) from public, anon, authenticated;
revoke execute on function queue_auth_sync() from public, anon, authenticated;
revoke execute on function auth_sync_reconcile() from public, anon, authenticated;
revoke execute on function auth_sync_claim(int) from public, anon, authenticated;
revoke execute on function auth_sync_report(uuid, text, text, boolean, timestamptz, text) from public, anon, authenticated;
grant execute on function auth_sync_reconcile() to service_role;
grant execute on function auth_sync_claim(int) to service_role;
grant execute on function auth_sync_report(uuid, text, text, boolean, timestamptz, text) to service_role;
revoke execute on function request_auth_sync_retry(uuid) from public, anon;
grant execute on function request_auth_sync_retry(uuid) to authenticated;
