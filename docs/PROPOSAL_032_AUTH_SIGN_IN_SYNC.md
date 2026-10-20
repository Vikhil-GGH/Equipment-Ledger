# Proposal 032: block sign-in for revoked accounts (redesigned)

**Status:** for approval. Not applied anywhere. Files:
- `supabase/proposals/032_auth_sign_in_sync.sql` + `032_down.sql`;
- the Edge Function in `supabase/proposals/auth-sync/` (`sync.ts` logic, `index.ts` Deno entry);
- tests in `supabase/tests/db/auth-sync.db.test.ts` (15).

The earlier design wrote Supabase's Auth tables directly; it's withdrawn and deleted.

## Requirements and how they're met

| Requirement | How |
|---|---|
| Supported API, server-side credentials only | Bans and unbans go through the Auth Admin API (`auth.admin.updateUserById(id, { ban_duration })`) in an Edge Function. The service-role key is a Supabase function secret, never in the app, the repository or the browser. Nothing writes `auth.*` tables |
| Revoke database access immediately, independently of Auth | Remove / Restore access are unchanged from 030. Data access changes in the database transaction itself; the Auth step happens afterwards, outside it |
| Record and audit sync failures | `auth_sync_state` (one row per account: status, attempts, last error, whether the current ban is ours) and append-only `auth_sync_events` (requested, blocked, unblocked, already, not ours, failed with the error, superseded, reconciled, retry requested, with who caused it) |
| Safe, idempotent retries | Each run recomputes what the account **should** be from `profiles` (the source of truth), never from a queued instruction. Running twice changes nothing. Failed accounts back off 2, 4, 8 … up to 60 minutes. A claim takes a 5-minute lease, so two runs never handle the same account, and a crashed run's accounts are picked up when its lease expires |
| Reconciliation | Every run first queues any account whose Auth state could disagree with its access state, and re-checks every revoked account daily. A ban lifted in the dashboard, or an unrelated ban that expired, gets re-applied |
| Never remove an unrelated ban | The sync lifts a ban only if **it** applied it **and** the ban's end time is still exactly what it set. A ban that already existed, or one changed in the dashboard after the sync set it, is left alone and recorded as *not ours* |
| A ban or unban failure can't grant data access | The sync functions never write `profiles`. Data access is decided by `profiles` alone (030/031). Tested: under success and every failure, `profiles`, the access history and business tables are byte-identical. A failed **unban** fails closed (sign-in stays blocked until the retry) |

## Flow

```
Admin (two-factor) ── Remove access ──▶ database: role → viewer, access_revoked_at set   ← data access gone NOW
                                         └ trigger → auth_sync_state = pending, event "requested"
App ── POST /functions/v1/auth-sync (admin's own aal2 token) ─┐
Schedule every 15 min ── POST (x-auth-sync-secret) ───────────┤
                                                              ▼
Edge Function: authorize caller → auth_sync_reconcile() → auth_sync_claim(25)
   for each account: desired = from profiles; read banned_until (Admin API)
     blocked   : not banned → ban 876000h (ours) | banned by us → "already" | banned by others → "not ours"
     unblocked : not banned → done | our unchanged ban → unban | any other ban → "not ours" (left)
   auth_sync_report(…)  → status synced / failed / not_ours; access changed meanwhile → "superseded", queued again
```

**Who may call the function:**
- the scheduler, with a shared secret of at least 32 characters, compared in constant time;
- or an admin with a two-factor session: their token is validated by Supabase Auth, its `aal` claim must be `aal2`, **and** `is_admin()` must be true when evaluated as that user.

Everything else gets 401/403. The database functions the sync uses are executable by `service_role` only. Admins with two-factor can read the state and the events, and can request a retry (`request_auth_sync_retry`); nobody can write them directly.

## Scheduled worker (proposed)

| Concern | Design |
|---|---|
| Trigger | **Supabase Cron** (`pg_cron`) every 15 minutes calls the function with `pg_net` (`POST …/functions/v1/auth-sync`, header `x-auth-sync-secret`). The secret is kept in **Supabase Vault** and read by the cron job; it's never in the repository. The app also calls the function right after Remove/Restore, so the schedule is the safety net, not the main path |
| Trust | Only the scheduler secret (≥ 32 random characters, constant-time compare) or an admin's own two-factor token is accepted. The service-role key exists only as a function secret |
| Concurrency | A claim gives each account a **5-minute lease** (`in_progress`) under `for update skip locked`, so overlapping runs never handle the same account. If a worker crashes, its lease expires and another worker takes over. Tested with two workers and a crash |
| Retries | Failures back off 2, 4, 8 … up to 60 minutes and keep retrying. Every attempt is counted and its error recorded |
| Reconciliation | Every run first queues any account whose sign-in state could disagree with its access state, and re-checks revoked accounts daily |
| Audit | `auth_sync_events`: append-only, with who caused each change; readable by admins with two-factor |
| Monitoring | Access & Roles shows accounts in *failed* or *not ours*. The smoke check fails if any account has been *failed* for more than an hour |
| Token lifetime | **Unchanged** (Supabase default) until the staging results; then revisited |

## What a ban does in Supabase Auth (to verify on staging, step B in the plan)

| | Expected | How it will be verified |
|---|---|---|
| New password sign-in | Refused ("User is banned") | Synthetic account: revoke → sync → sign in |
| Refresh token | Refused, so the session ends at its next refresh | Same account, a session opened before the revoke: refresh |
| Already-issued access token | Valid until it expires (at most the JWT expiry, 1 hour by default) but **grants nothing**: the database refuses every request (030, verified on staging) | Same session: read tables before the token expires |
| Restore | Sign-in works again after the sync | Restore → sync → sign in |

## App changes (with 032)

- After Remove/Restore access, the app calls the function and shows the result: *Sign-in blocked* / *pending* / *failed — Retry*.
- Access & Roles shows each removed account's sign-in state, with a **Retry** button that calls `request_auth_sync_retry` and then the function.

## Deployment needs (decisions)

1. **Edge Functions:** deploy `auth-sync` with `supabase functions deploy auth-sync` on approval, with secrets `AUTH_SYNC_CRON_SECRET` and `SUPABASE_ANON_KEY`. Supabase provides the URL and the service key.
2. **Scheduler:** recommended is Supabase Cron (`pg_cron` + `pg_net`) calling the function every 15 minutes, with the secret stored in Supabase Vault. The alternative is an external scheduler.
3. **JWT expiry:** unchanged for now (as decided). Revisit after the staging results.

## Rollback

`032_down.sql` stops queuing and removes the sync functions. It **keeps** the audit trail and every ban already applied. The owner decides per account: `ban_owned = true` means the sync applied it. Unschedule and undeploy the function first.

## Residual risks

- **Window before the ban:** between Remove access and the sync (seconds when the app calls it; at most 15 minutes from the schedule), the person can still sign in. They see nothing (database).
- **Crash between the ban and the report:** if the worker crashes after banning but before recording it, the next run sees a ban it can't prove is its own, and records *not ours*. It then never lifts it automatically: this fails closed, and the owner lifts it in the dashboard if the account is restored.
- **Service key:** it can do anything in the project. It lives only in the function's secrets; the function's code paths are limited to reading `banned_until` and setting or clearing a ban.
