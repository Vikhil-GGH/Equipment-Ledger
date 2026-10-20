# Staging execution plan: migration 031 (two-factor for all admin access)

**Status:** for approval. **Nothing in this plan runs until you approve it.** Hosted staging only (`ioqfvkvrlamyzowwescf`); production stays blocked by the tools. The staging tools now verify the database certificate.

## Before the plan (already approved; needs your hands)

**P1. Remove access from the remaining synthetic admin account**, in the app at http://localhost:5180 (staging bar visible), signed in with your code:
- Access & Roles → **`zz-acc-1619-admina@example.invalid`**, id `20ce638b-a70b-425f-a54a-09a59fe28acb`, role *viewer*, no "Access removed" badge.
- Click **Remove access**, reason `ZZ-ACC-1619 cleanup`, and confirm.
- Check the row now shows *Access removed … was viewer*.
- No other account changes.

**P2. Evidence I then collect (read-only):**
- The profile is revoked.
- Exactly one new access-history entry: actor = you, target = admina.
- The comparison passes with `--authorized-actor <you>`: every other row is unchanged.

## B. The 031 run (needs approval)

| # | Step | Command | Evidence / stop condition |
|---|---|---|---|
| 1 | Confirm target, production blocked, TLS verified | any staging tool (header line) | `Staging project: ioqfvkvrlamyzowwescf (production <hidden> is blocked)`, no TLS warning |
| 2 | Baseline + recovery point | `npm run staging:snapshot -- save staging-pre-031` | "saved and verified", with Auth fingerprints. Also note the time for Supabase's own backups |
| 3 | Backup restores, and 031 rehearsed on the copy | restore check with `UNTIL=20260901000031 REHEARSE=1` | Every table identical; after 031 on the copy, every row unchanged. **Stop otherwise** |
| 4 | Only 031 pending | `npm run staging:migrate -- --dry-run` | Exactly `20260901000031_admin_mfa_everywhere.sql`. **Stop otherwise** |
| 5 | Apply | `npm run staging:migrate` | ✔ for 031 |
| 6 | Compare all records | `npm run staging:snapshot -- compare staging-pre-031` | Every pre-existing row unchanged, nothing added. **Stop otherwise** |
| 7 | Rolled-back database tests | `npm run staging:test-db` | All pass, including `admin-mfa-live` (temporary users, rolled back) |
| 8 | Read-only API checks | `npm run staging:verify`, `npm run staging:smoke -- post` | See **reader account** below |
| 9 | Browser, read-only | scripted, non-GET requests blocked | Your password-only sign-in shows only the code prompt. With your code: the app works, and Access & Roles shows the promotion message when trying to promote a non-enrolled synthetic account (not submitted) |
| 10 | Final comparison | step 6 again | Unchanged |

**Rollback if needed:** `supabase/rollback/20260901000031_down.sql`, inside a transaction. Tested locally: it restores the 030 definitions exactly.

### The reader account (needs approval with B)

After 031, a password-only admin session sees nothing. The read-only checks never automate your two-factor, so they need a **synthetic viewer**:
- `zz-verify-reader@example.invalid`, role **viewer**;
- created the same way as the ZZ-ACC accounts, with a random password;
- password stored only in `.env.staging.local` (`STAGING_READER_EMAIL` / `STAGING_READER_PASSWORD`, gitignored, staging only).

A viewer can read but never change anything. The checks already use it once configured, and the smoke test *also asserts* that your password-only session sees only its own profile.

Without the reader, steps 8's read checks fail by design, with a message naming the missing settings.

## C. Supabase Auth checks with synthetic accounts (needs approval)

These are Auth behaviours the database can't test. They use temporary ZZ accounts only, never yours.

| Check | Expected |
|---|---|
| Admin with a verified factor, new password-only session | aal1 → only own profile; the app shows the code prompt |
| Same session tries to **enrol an additional factor** | **Refused** by Supabase Auth (needs aal2 once a verified factor exists) |
| With the code (aal2): replace the factor (enrol new → verify → remove old) | Works, and the account is never without a verified factor |
| Sign out, then sign in with the new factor's code | aal2, full access |
| Recovery drill: a second synthetic admin demotes the first; the first's factor is removed; promotion refused until re-enrolled | As in docs/ADMIN_MFA_PROCEDURES.md §4 |

Removing a synthetic account's factor needs the Admin API or the dashboard. With no service key on this machine, that step is **yours**, in the dashboard, on the synthetic account only. Everything else is scripted with in-memory secrets, as before.

## What stays untouched

- **Your account:** role, factor and sessions are never touched by these runs.
- **Data:** no employee or equipment record is changed; no real imports; no pushes or deploys.
- **Other migrations:** 032 is not applied (it needs its own approval after review).
