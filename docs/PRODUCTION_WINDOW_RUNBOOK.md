# Production migration window: exact steps

**Status:** rehearsed, **not run.** Every step that changes production needs the owner's go at that moment. Run everything from `C:\Users\VikhilBaswaraju\Projects\equipment-ledger` in your own terminal; the scripts ask for the password (hidden) and never store it.

## What was proved on the real production backup
Backup `…\EquipmentLedger-prod-backup-2026-10-22` (taken 2026-10-22, 12 tables, 468 rows, SHA-256 of `data.json` `3479a7f2…13ec2`), rehearsed on an isolated restored copy:
- production's schema is **identical** to the expected one (migrations 001–014 + 016): the hand-made Monitors table matches migration 016 exactly;
- the restored copy matches the backup in every table (row counts and content hashes);
- the plan equals production's: apply 015, record 016, apply 017–020, apply 021–030, 033–035 (18 steps);
- **no pre-existing column of any pre-existing row changed at any of the 18 steps** (all 468 rows: 57 inventory laptops, 114 active laptops, 31 monitors, their histories, 3 imports, 1 profile);
- the 4 duplicate-serial groups (8 devices) are kept and listed by 027, never merged;
- the final schema equals a clean build from the migration files;
- rollbacks 035 → 029, through the same tool used in the window, leave the rows untouched and return the schema to the state after 028.

## Before the window (all read-only or preparation)
1. Supabase Dashboard: Authentication > Providers: **TOTP multi-factor ON**; sign-ups as decided; **anonymous sign-ins OFF**. Database > Backups: note the latest restore point (second recovery path).
2. The new app is **ready to deploy** (Vercel project and branch prepared; see [DEPLOY_VERCEL.md](DEPLOY_VERCEL.md)). The old app and the migrated database are not compatible, so there is downtime between the first migration and the deployment: keep it short.
3. Tell the other users: **freeze**: no edits, imports, onboarding or offboarding during the window.

## The window
Let `$B = "$env:USERPROFILE\EquipmentLedger-prod-backup-2026-10-22"`.

**A. Prove nothing changed since the rehearsal (read-only)**
```
run-preflight.ps1 -Task compare -BackupDir $B      # must end: Every pre-existing table equals the backup
run-preflight.ps1 -Task plan                       # must show the same 18 steps
```
If a table differs (someone worked after the backup): stop, take a new backup (`-Task backup -OutDir <new folder>`), re-run the rehearsal on it, continue with that folder as `$B`.

**B. The 18 steps, one at a time, in this order.** After **each** step run the compare; it must stay clean. Stop on any error, any ✖, or any plan line other than the next expected step.
```
run-apply.ps1 -Apply  20260901000015
run-apply.ps1 -Record 20260901000016
run-apply.ps1 -Apply  20260901000017   then 018, 019, 020
run-apply.ps1 -Apply  20260901000021   then 022, 023, 024, 025, 026, 027, 028, 029, 030
run-apply.ps1 -Apply  20260901000033   then 034, 035
run-preflight.ps1 -Task compare -BackupDir $B      # after every step
```
`run-apply.ps1` asks you to type the project reference, then the password. It refuses anything that is not exactly the next step, anything partly in place, and anything already recorded; a failing step is rolled back completely and writes nothing.

**C. If something goes wrong:** stop. For 029 or later, `run-apply.ps1 -Rollback <version>` undoes the most recently applied migration (one at a time: 035, 034, 033, 030, 029). Before 029, or if in doubt, restore the Supabase restore point (the freeze means nothing is lost).

**D. After the last step (read-only):** `-Task preflight` (nothing pending, no STOP), `-Task probe`, final compare, then a new backup of the migrated database (`-Task backup -OutDir <new folder>`) as the post-migration record.

## Then (each needs approval)
1. Push the release branch (never `main` first; see [DEPLOY_VERCEL.md](DEPLOY_VERCEL.md)) and deploy the build from that commit.
2. The admin signs in (editor-level access works with a password alone), opens **Security**, enrols an authenticator, confirms "verified". Then enrol a second admin so a lost phone never locks you out.
3. Smoke checks in the app: Overview, Laptop Inventory, Onboarding/Offboarding, Active Employees, Bulk Stock, Export backup. Review the 4 duplicate-serial groups under Access & Roles; decide each (which record is the real device).
4. End the freeze.
