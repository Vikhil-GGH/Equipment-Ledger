-- =========================================================================
-- Rollback for the PROPOSED 032 (supabase/proposals/032_auth_sign_in_sync.sql).
-- Stops queuing sign-in syncs and removes the sync functions. Remove /
-- Restore access are untouched (032 never changed them).
--
-- Deliberately kept:
--   * auth_sync_events and auth_sync_state — the audit trail is never
--     deleted; both stay read-only (admins with two-factor can read them);
--   * every ban already applied in Supabase Auth. Decide per account, after
--     reading auth_sync_state (ban_owned = applied by the sync), whether to
--     lift it in the dashboard. Do NOT run this while the Edge Function is
--     still scheduled: unschedule and undeploy it first.
-- =========================================================================
drop trigger profiles_queue_auth_sync on profiles;
drop function queue_auth_sync();
drop function request_auth_sync_retry(uuid);
drop function auth_sync_report(uuid, text, text, boolean, timestamptz, text);
drop function auth_sync_claim(int);
drop function auth_sync_reconcile();
drop function auth_sync_desired(uuid);
