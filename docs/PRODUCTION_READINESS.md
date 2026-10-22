# Production readiness: findings and proposed plan

**Status:** for the owner's approval. **Security baseline: migration 030.** Migration 031 (two-factor for all admin access) and proposal 032 (sign-in blocking) were discontinued on 2026-10-21 (031 was applied to staging once, broke Bulk Stock, and was rolled back); they are archived in [archive/discontinued-031-032/](../archive/discontinued-031-032/README.md). Nothing here has touched production.

Contents:
1. Snapshot comparison fix
2. Two-factor for all admin access (discontinued)
3. Blocking sign-in for revoked accounts (discontinued)
4. CA-verified connections
5. Migration compatibility checklist, 021–030
6. Production preflight procedure
7. Decisions needed
8. Proposed execution plan

---

## 1. Snapshot comparison fix (done, local tooling)

`npm run staging:snapshot -- compare <label>` used to mark any table with added rows "CHANGED". It also only recognised synthetic records from the ZZ-SYN employee tests, so the ZZ-ACC profiles, access history and checklist showed as "not synthetic". It now:
- **Existing rows:** checks every pre-existing row by primary key, using the columns it had at the snapshot.
- **New rows:** classifies every new row, including rows in tables created after the snapshot. A row is synthetic if it carries a `--tag` or a tag from `.staging-state/synthetic-accounts-*.json`, or references a synthetic account or another synthetic row (`scripts/staging/classify.mjs`, 6 unit tests).
- **Auth:** compares logins and MFA factors without reading secrets. A new factor on an existing account counts as authorized only with `--authorized-mfa <email>`.
- **References to real accounts:** flags any synthetic row that references an existing account, for review.
- **Auth fingerprints:** new snapshots also store them, so later comparisons detect password, ban, role or metadata changes.

Rerun against the pre-test baseline (`staging-pre-acc`):
- every pre-existing row is unchanged;
- 13 additions, all synthetic: 4 profiles, 5 access-history entries, 1 monitor, 1 monitor history row, 1 serial key, 1 onboarding checklist;
- 4 synthetic logins and 1 synthetic factor;
- the only change to an existing account is the authorized TOTP factor.

Run without `--authorized-mfa`, the same comparison fails on that factor, as it should.

## 2. Two-factor for all admin access: migration 031 (discontinued)

Not part of the plan. 031 was applied to hosted staging, broke every Bulk Stock action (`FOUND` was lost when a role `SELECT` became an assignment), and was rolled back on 2026-10-21 with a verified, record-preserving procedure. For a small group of trusted users, 030's controls are enough: roles, revoked access, audit history, and two-factor for admin powers. Everything is kept in [archive/discontinued-031-032/](../archive/discontinued-031-032/README.md).

## 3. Blocking sign-in for revoked accounts: proposal 032 (discontinued)

Not part of the plan. Access removal in 030 already cuts database access immediately; the proposal only added banning the Auth login itself. A revoked person can still sign in but sees nothing. The owner can ban them in the Supabase dashboard if wanted. The design is archived with 031.

## 4. CA-verified connections

See [docs/DATABASE_SSL.md](DATABASE_SSL.md).
- **Done:** the production preflight now **refuses** to connect without `PREFLIGHT_DB_SSL_CA`, unless you explicitly opt out with `PREFLIGHT_ALLOW_UNVERIFIED_TLS=1`.
- **Done:** the staging tools now accept an absolute CA path.
- **Verified on staging:** connection with the certificate checked; wrong CA refused.
- **Staging: enabled (2026-10-20).** The Supabase CA (fetched over HTTPS) matches the root the staging server presents, SHA-256 `80:70:25:AD…E6:CA:FA`; staging tools now verify it. Production: download its CA when the preflight is approved.

## 5. Migration compatibility checklist, 021–030 and 033–035

Production's current state is unknown; the preflight reports it. All of these migrations ran on staging (PostgreSQL 17.11) through the same runner, one transaction each. Every one fails *safely*: an error rolls back the whole migration.

| # | Needs before | Fails (safely) if | Data change on apply | Rollback | Preflight check | Check after |
|---|---|---|---|---|---|---|
| 021 | 001–020 | the two functions whose return type changes still exist and the adaptation isn't included | adds `moved_from_inventory` (default false) | **none** (predates the convention) | 021 state; fix-up note | lifecycle actions; Inventory ↔ Active Laptops counts |
| 022 | 021; `auth.users.is_anonymous`, `auth.uid()`, `auth.jwt()` | the policy `profiles.profiles_update_admin_or_self` is missing or renamed | anonymous profiles pinned to viewer (backup in `private`) | yes | anonymous accounts; Auth objects; dropped names | anonymous session reads nothing |
| 023 | 022 | any of the 20 named ledger policies is missing or renamed | none | yes | dropped names; **hand-made policies** | no raw table writes |
| 024 | 023 | — | derives `laptop_outcome`; conflicts set `outcome_needs_review` | yes | — | review flags listed |
| 025 | — | — (adds an enum value; nothing uses it in the same transaction) | none | yes | — | `lost` available |
| 026 | 025 | constraint `onboarding_checklists_assigned_asset_id_fkey` missing or renamed | employees + register backfilled from assignments; checklists linked | yes | dropped names | register matches every device (smoke) |
| 027 | 026 | — (duplicate serials are kept and listed, not refused) | `serial_keys` built | yes | duplicate serials | duplicates listed |
| 028 | 027 | employees share a normalized work email | new columns, empty | yes | shared emails | — |
| 029 | 028 | Bulk Stock items share a normalized name + category; `commit_bulk_import(text, jsonb)` missing | new column/table | yes | shared bulk names; dropped names | re-import adds nothing |
| 030 | 029 | `import_events_insert_editor` or `profiles_delete_admin` missing or renamed | new columns/table | yes (refuses while any account is revoked) | admins + MFA; dropped names | admin powers need two-factor |
| 033 | 030 | — (replaces functions and one view; adds triggers; no data-dependent statements) | none: no row is changed (proved on a copy of staging data) | yes (exact) | object marker `canonical_assignee` | retained laptop is not a mismatch; unknown Bulk Stock item message; duplicate offboarding refused |
| 034 | 033 | — (replaces one function) | none | yes (exact) | function marker | assigning a set-aside device by serial needs it unassigned with no open register issue |
| 035 | 034 | — (drops and recreates two functions with a new argument, replaces one) | none | yes (exact) | function marker | Provide of a Decommissioned device needs the confirmation; Non-functional can never be issued |

Applies to all of them:
- **Size:** small tables (hundreds of rows), so each migration takes seconds and locks briefly.
- **Schema cache:** Supabase reloads the API schema cache automatically after changes.
- **Order:** database first, then the app. The new app needs the new schema; old app builds keep working except "delete profile", which now fails safely.
- **Hand-made objects:** anything created in the dashboard that the migrations don't know about can change the security picture. Hand-made policies, API-callable security-definer functions and tables without RLS are **STOPs** in the preflight.

## 6. Production preflight procedure

The preflight never writes; it runs in a read-only transaction. It's tested on disposable databases (`preflight.db.test.ts`, 6 tests): a clean database at 020 shows only the expected 021 fix-up, and four kinds of drift are caught. On staging it reports no STOPs.

**What the owner runs, from a trusted machine:**
1. Download the production CA (see section 4).
2. Run:
   `PREFLIGHT_DB_URL='…' PREFLIGHT_DB_SSL_CA=certs/supabase-prod-ca.crt node scripts/production/preflight.mjs`
   The connection string comes from the environment only, never from a file in the repository.
3. Keep the output. It contains counts and object names, no personal data except Bulk Stock names if duplicates exist. Send it for review.
4. **Dashboard checks** (Auth settings aren't visible from the database):
   - anonymous sign-ins **off**;
   - TOTP multi-factor **enabled**;
   - point-in-time recovery or daily backups enabled, with the latest backup time noted;
   - PostgreSQL version noted.

**What the preflight checks:**
- **Connection security:** TLS verified.
- **Platform:** PostgreSQL ≥ 15; the Auth objects the migrations use.
- **What's applied:** recorded migrations, 001–020 present, which of 021–030 are pending, and the 021 state.
- **Every object a pending migration drops by name exists**, or is created earlier in the plan.
- **Drift:** policies, API-callable security-definer functions and tables without RLS that no migration created.
- **Data conditions:** anonymous accounts, duplicate serials, shared work emails, shared Bulk Stock names.
- **Admin readiness:** admins and their two-factor status.
- **Size:** row counts.

**A STOP means do not migrate.** Each STOP names the decision it needs.

## 7. Decisions

| # | Decision | Status |
|---|---|---|
| D1 | 031: no business-data access for admins without two-factor | **Discontinued** (2026-10-21) |
| D2 | 032: Auth Admin API, not direct writes | **Discontinued** (2026-10-21) |
| D3 | Two production admins, both with two-factor | Recommended; procedure written |
| D4 | 021 has no rollback | Open: accept, or I write one |
| D5 | Duplicates found by the production preflight | Pending actual findings |
| D6 | Production migration process | **Decided**: reviewed Supabase CLI process ([PRODUCTION_MIGRATION_PLAN.md](PRODUCTION_MIGRATION_PLAN.md)) |
| D7 | Before/after copy of production data | **Decided**: encrypted, restore-tested, deleted after retention |
| D8 | Staging synthetic `zz-acc-1619-admina` | Approved: you remove its access (plan P1) |
| D10 | 021 adaptation with the CLI, if 021 is pending: SQL-editor step during the freeze, or the reviewed runner | Open; only if the preflight shows 021 pending |
| D11 | 032 scheduler and JWT expiry | **Moot** (032 discontinued) |
| D12 | Staging reader account `zz-verify-reader@example.invalid` (viewer) | Optional: still used by the read-only checks if configured; admin is used otherwise |

## 8. Proposed execution plan

Staging is on 030. See [PRODUCTION_MIGRATION_PLAN.md](PRODUCTION_MIGRATION_PLAN.md) (checkpoints CP0–CP8) for production. Every step needs its own approval.
