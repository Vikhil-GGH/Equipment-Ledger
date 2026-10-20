# Production migration plan (022–030) — draft, not approved

Nothing here has been run against production. Each step needs the owner's approval; stop at any STOP or unexpected result.

## What the migrations do

| # | Change | Data change on apply |
|---|---|---|
| 022 | Closes anonymous access; pins existing anonymous profiles to viewer (backup in `private`). | Anonymous profiles' role only |
| 023 | Removes raw table writes; all writes go through functions. | None |
| 024 | One laptop outcome on offboarding (derived from the old checkboxes; conflicts flagged for review). | New column, derived values |
| 025 | Adds the `lost` status. | None |
| 026 | Employee equipment register; backfills one register row per assigned device and links checklists to employees. | New tables, backfill |
| 027 | One device per serial (existing duplicates kept and listed), safe Excel imports, verified restore. | New registry table |
| 028 | Active Employees directory fields and history. | New columns (empty) |
| 029 | Activation safeguards; Bulk Stock imports recorded as deliveries; one bulk item per name + category. | New column/table |
| 030 | Import History written only by imports; Remove access instead of deleting profiles; two-factor for admin powers. | New columns/table |

Every migration has a rollback in `supabase/rollback/` (run in reverse order, one at a time).

## Before the change window

1. **Read-only preflight** (run by the owner, from a trusted machine):
   `PREFLIGHT_DB_URL='…production connection string…' node scripts/production/preflight.mjs`
   It reports OK / INFO / STOP and never writes. Any STOP must be resolved first:
   - **021 not applied** → apply 021 with `supabase/adaptations/021_before_drop_changed_functions.sql` in the same transaction (it drops two functions whose return type 021 changes; nothing else depends on them).
   - **Bulk Stock items sharing a name + category** → decide which to keep (029 never merges); otherwise 029 fails safely.
   - **Employees sharing a work email** (only if 026 already exists) → resolve, otherwise 028 fails safely.
2. **Admin two-factor**: after 030, admin powers need a two-factor session. The admin can enrol on the Security page at any time (also before 030, once the new frontend is live).
3. **Auth settings** (Supabase dashboard): anonymous sign-ins OFF; TOTP multi-factor enabled.
4. **Full backup**: a database backup/PITR point, plus the app's Export backup (verified counts since 027).

## Change window

1. Announce a short freeze (no imports, onboarding, offboarding or backups during the window).
2. Fresh backup; preflight again (must be clean).
3. Apply migrations **one at a time**, in order, each in its own transaction, recording each in the migration history — the same procedure as staging (`scripts/staging/apply-migrations.mjs`, which refuses production by design; production needs a separately reviewed runner or the Supabase CLI).
4. After each: compare pre-existing rows with the backup (as `staging:snapshot -- compare` does on staging). Stop on any unexpected change.
5. Deploy the frontend built from the same commit (the database first, then the app: older frontends keep working against the new schema except the removed "delete profile" path).
6. Smoke checks: sign in, Overview, Laptop Inventory, Onboarding/Offboarding lists, Export backup (counts verified), Access & Roles (admin with two-factor).

## Rollback

Per migration, in reverse order, inside a transaction: `supabase/rollback/2026090100003N_down.sql` … Each saves what it removes to `private.*_backup_*` tables. 030's rollback refuses to run while any account's access is removed (it would give them read access again). Restore from backup only if a rollback can't be used.

## Known decisions for the owner

- Existing duplicate serials, if any, are kept and listed for review (not merged).
- Existing employees start as "Not in directory" until the official list is uploaded.
- The Excel "Employee Status" mapping is explicit (`src/features/employees/employeeStatusMapping.ts`); other values need a decision.
