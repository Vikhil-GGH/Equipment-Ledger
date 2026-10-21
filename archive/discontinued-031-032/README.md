# Discontinued: migration 031 and proposal 032

**Decision (2026-10-21):** Equipment Ledger will have the owner and a few trusted users. The security baseline is **migration 030** (roles, access controls, revoked access, audit history, two-factor for admin powers). Migration 031 and proposal 032 are discontinued and must not be applied.

## What these were
- **031: two-factor for all admin access.** A password-only admin session would see nothing. It was applied to hosted staging once, broke every Bulk Stock action (`FOUND` was not set after `v_role := session_role()`), and was rolled back on 2026-10-21. A corrected version exists here but was never applied.
- **032: block sign-in for revoked accounts** with the Auth Admin API, a claim lease and a scheduled worker. It was a proposal only; nothing of it ever ran.

## Why nothing here can run
Everything is outside the folders the tools read, and code files carry an `.archived` suffix:
- `staging:migrate` and the SQL test harness read only `supabase/migrations/*.sql`.
- Vitest runs only `src/**` and `supabase/tests/db/**`.

## Contents
| Path | What |
|---|---|
| `migrations/20260901000031_admin_mfa_everywhere.sql.archived` | Corrected 031 (never applied). |
| `rollback/20260901000031_down.sql.archived` | Its rollback. The six `commit_*`/`create_bulk_item`/`is_*` bodies must be applied with the line endings staging recorded (CRLF), or the schema fingerprint differs. |
| `scripts/generate-031.mjs.archived` | Generator that produced 031 from the 030 definitions. |
| `tests/admin-mfa*.archived` | The 031 database tests. |
| `docs/STAGING_031_EXECUTION_PLAN.md` | The staging run plan. |
| `docs/PROPOSAL_032_AUTH_SIGN_IN_SYNC.md` | The 032 design. |
| `docs/ADMIN_MFA_PROCEDURES.md` | Admin enrolment and recovery written for 031. Parts (enrolling a factor on the Security page) still apply to 030. |

The 032 SQL, the Edge Function worker and its tests were deleted; they remain in git history (commit `d5cec42` and earlier).

## Lesson kept
`perform_bulk_action` checks `FOUND` after `EXECUTE`. Replacing the role `SELECT` with `:=` silently changed `FOUND`. Every function that a migration rewrites needs a positive test that runs its normal path.
