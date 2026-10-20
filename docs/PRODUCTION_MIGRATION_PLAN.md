# Production migration plan (021–031): draft, not approved

**Status:** nothing here has been run against production. Every checkpoint (CP) needs the owner's explicit approval; stop at any STOP or unexpected result. See also:
- [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md): checklist per migration, preflight, decisions;
- [ADMIN_MFA_PROCEDURES.md](ADMIN_MFA_PROCEDURES.md): two admins, bootstrap, recovery;
- [DATABASE_SSL.md](DATABASE_SSL.md): verified connections.

032 (sign-in blocking) is a separate proposal ([PROPOSAL_032_AUTH_SIGN_IN_SYNC.md](PROPOSAL_032_AUTH_SIGN_IN_SYNC.md)) and is not part of this plan until approved.

## What the migrations do

| # | Change | Data change on apply | Rollback |
|---|---|---|---|
| 021 | Laptops move between Inventory and Active Laptops | New column (default false) | none |
| 022 | Closes anonymous access; pins anonymous profiles to viewer (backup in `private`) | Anonymous profiles' role only | yes |
| 023 | Removes raw table writes; all writes go through functions | None | yes |
| 024 | One laptop outcome on offboarding (conflicts flagged) | New column, derived values | yes |
| 025 | Adds the `lost` status | None | yes |
| 026 | Employee equipment register; backfill; checklists linked | New tables, backfill | yes |
| 027 | One device per serial (duplicates kept and listed); safe imports; verified restore | New registry table | yes |
| 028 | Active Employees directory fields and history | New columns (empty) | yes |
| 029 | Activation safeguards; Bulk Stock deliveries; one bulk item per name + category | New column/table | yes |
| 030 | Import History written only by imports; Remove access; two-factor for admin powers | New columns/table | yes (refuses while any account is revoked) |
| 031 | Two-factor for **all** admin access; no admin without an authenticator | None | yes |

## Approval checkpoints

| CP | Gate | Evidence the owner sees |
|---|---|---|
| CP0 | Staging complete (031 applied and checked; 032 decided) | Staging reports |
| CP1 | Run the production preflight (read-only) | Preflight output |
| CP2 | Decisions on every STOP/INFO (duplicates, hand-made objects, admins, 021 handling) | Written decisions |
| CP3 | Go / no-go for the window | Fresh backup verified (below), preflight clean again, CLI dry-run lists exactly the pending migrations, freeze announced |
| CP4 | After **each** migration: continue? | Row-level comparison: pre-existing rows unchanged |
| CP5 | Deploy the frontend (same commit) | Build from the tagged commit |
| CP6 | Admin enrolment and smoke checks | Both admins with two-factor; smoke results |
| CP7 | End the freeze | Final comparison |
| CP8 | Destroy the window's backups after the retention period | Deletion logged |

## Before the window

1. **Preflight (CP1)**, run by the owner from a trusted machine, read-only:
   `PREFLIGHT_DB_URL='…' PREFLIGHT_DB_SSL_CA=certs/supabase-prod-ca.crt node scripts/production/preflight.mjs`
   Duplicates (serials, work emails, Bulk Stock names) are decided **only on the real findings**; the migrations never merge.
2. **Dashboard settings:**
   - anonymous sign-ins OFF; TOTP multi-factor ON;
   - public sign-ups as decided;
   - point-in-time recovery or daily backups on, and the latest restore point noted.
3. **Admins:** decide who the two admins are (D3). Existing admins without an authenticator lose all access at 031 until they enrol, so they enrol in the window right after the frontend is deployed (step 7 below). If an admin's password may be known to anyone else, reset it first.

## Migration process: Supabase CLI (preferred)

The same per-migration transaction and history table as staging. **Validate on staging first, read-only:** does `supabase migration list` show staging's history (recorded by our runner) correctly?

1. **Pin the CLI:** use an exact version via `npx supabase@<version>`, and record it in the change log.
2. **Release workspace:** a clean checkout of the approved commit.
   - `supabase/.temp/` (CLI link state) is gitignored.
   - The database password is typed when prompted. It's never stored in a file or the repository, and never echoed.
3. **Link:** `supabase link --project-ref <production ref>`.
4. **Check the history:**
   - `supabase migration list` must match the preflight's "Recorded migrations".
   - `supabase db push --dry-run` must list exactly the pending files (CP3).
5. **One migration at a time** (CP4):
   1. The workspace's `supabase/migrations/` contains files only up to the next pending one; `supabase db push` applies just that one.
   2. Run the row-level comparison (below).
   3. Add the next file and repeat.
6. **If 021 is pending:** the CLI can't run 021's adaptation in the same transaction. Two options (decision D10):
   - **(a)** during the freeze, run `supabase/adaptations/021_before_drop_changed_functions.sql` in the SQL editor (it drops two functions that 021 recreates), then immediately push 021. For those seconds, lifecycle actions and swaps fail, which is harmless while frozen.
   - **(b)** use the reviewed runner, which runs both in one transaction.
7. **TLS:** the preflight and the comparison tools verify the certificate. The CLI's own connection handling should be confirmed on staging; until then, run it only from a trusted network.

## Backups: encrypted handling

Production data includes employee personal data, so every copy is handled as confidential.

1. **Primary recovery:** Supabase point-in-time recovery or daily backups. Note the restore point immediately before the window.
2. **Logical copy** (for the before/after comparison and a second recovery path), on the trusted machine:
   - `supabase db dump --linked -f schema.sql` and `supabase db dump --linked --data-only -f data.sql`;
   - **encrypt immediately**, e.g. `age -r <owner's public key> -o data.sql.age data.sql` (or GPG / 7-Zip AES-256), then delete the plaintext;
   - record the SHA-256 of the encrypted files in the change log.
3. **Where copies live:** only on an encrypted disk (BitLocker); never in the repository, a cloud-synced folder, email, chat, tickets or AI tools.
4. **Restore test before CP3:** decrypt on the trusted machine, load into a disposable local database, and compare row counts with the preflight's. A backup that hasn't been restored doesn't count.
5. **The app's Export backup** gets the same handling.
6. **Retention:** delete all window copies 30 days after CP7 (or as decided), and log the deletion (CP8).

## The window

1. Freeze: no imports, onboarding, offboarding or backups.
2. Fresh restore point plus encrypted logical copy (restore-tested); preflight again, which must be clean (CP3).
3. Apply the pending migrations one at a time (CLI process above). After each, compare every pre-existing row with the copy (CP4).
4. Deploy the frontend built from the same commit (CP5).
5. Admins enrol and sign in with the code ([ADMIN_MFA_PROCEDURES.md](ADMIN_MFA_PROCEDURES.md)); promote the second admin (CP6).
6. **Smoke checks:**
   - sign-in;
   - a password-only admin session sees only the Security page / code prompt;
   - with the code: Overview, Laptop Inventory, Onboarding/Offboarding, Export backup (counts verified), Access & Roles.
7. Final comparison; end the freeze (CP7).

## Recovery

- **One migration misbehaves** (comparison shows an unexpected change): stop. Run that migration's rollback (`supabase/rollback/<version>_down.sql`) inside a transaction, compare again, and decide.
  - Rollbacks run in reverse order, one at a time; each keeps what it removes in `private.*_backup_*`.
  - 030's refuses while any account is revoked. 021 has none (it adds one column).
- **Rollback impossible, or data damaged:** restore the point-in-time backup to the restore point noted before the window. This also restores Auth. Then redeploy the previous frontend. The freeze means nothing is lost.
- **Admin locked out after 031:** [ADMIN_MFA_PROCEDURES.md](ADMIN_MFA_PROCEDURES.md) §4–5. Rolling back 031 is a last resort; it restores editor-level access for password-only admins.
