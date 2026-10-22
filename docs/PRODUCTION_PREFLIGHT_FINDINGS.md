# Production preflight: findings and the corrected plan

**Source:** the owner's read-only preflight of production (project `jhwhftaffsjulrvtajnl`, PostgreSQL 17.6, server certificate verified, exit code 2, nothing written). Analysis done on disposable databases; **nothing has been applied to production.**

## What the report says
| Finding | Reading |
|---|---|
| Recorded migrations 001–014; 015–020 missing from history | The history table and the schema disagree (below) |
| Row counts: 57 inventory laptops, 114 active laptops, **31 monitors**, 0 Bulk Stock, 0 onboarding / offboarding, 3 imports | `monitors` exists, so **015 and 016 are in place**. `other_equipment` is not in the list the preflight prints when the table exists, so **019 is not in place** |
| 4 expected objects missing | All four are `other_equipment` policies (`other_equipment_insert`, `_update_editor`, `_delete_admin`, `other_equipment_history_insert_admin`) that migration 023 drops: **they are the footprint of the missing 019**, not unrelated drift |
| 021 preparation not applied | Expected: 021 needs its documented adaptation in the same transaction |
| No policies, definer functions or tables outside the migrations; every API table has row-level security | No hand-made objects to worry about |
| 4 duplicate-serial groups / 8 devices | Information for 027, which keeps and lists them |
| Admin MFA 0 of 1 | Needs the steps below |

## 0. Confirmed by the probe and plan (read-only, exit 0)
Production is **001–014 plus 016 only**. In place but unrecorded: **016** (monitors table, view, policies, trigger). **Absent: 015** (the enum value `monitors` is missing although the table exists), **017** (`handle_new_user` does not mention `is_anonymous`), **018** (enum value `other_equipment`), **019** (the whole other_equipment collection) and **020** (`restore_backup`). The plan is therefore: apply 015, record 016, apply 017–020, then 021–030, 033–035 (18 steps, in that order).

The unusual 015/016 order (the table exists without its enum value) is safe in principle, because 015 only adds an enum value and nothing in 016 uses it, but it means production's Monitors table was hand-made. **That is why the backup captures the full schema, and the rehearsal requires production's schema to equal the expected one exactly** (any hand-made difference in columns, defaults, policies, triggers, functions or indexes stops the rehearsal and is reported).

## 1. Why 015–020 are missing from history, and what exists
Production was built partly by hand, not purely from these files. Migration 017's own header says its text cannot create a user and that "production evidently runs a working version". So 015, 016 (and possibly 017, 018, 020) were applied outside the CLI and never recorded. The report proves 015/016 in place and 019 absent. **017, 018 and 020 are not settled by the report**: run the probe below (read-only). Either way the plan handles every combination.

## 2. Can 021 onward run safely against the real schema?
Yes, **once 019 is applied** (023 drops the other_equipment write policies 019 creates), and with history reconciled first. This was rehearsed (`supabase/tests/db/production-chain.db.test.ts`) on disposable databases shaped like production (57 + 114 laptops with 4 cross-table duplicate serials, 31 monitors, one admin, history stopping at 014):
- the likely state (015–018 in place, 019–020 missing), everything-in-place-but-unrecorded, and nothing-beyond-014 all complete;
- the business rows (id, name, serial, status, assignee, location) are identical before and after, the row counts are unchanged, duplicates are kept and listed, never merged;
- **the final schema is identical to a database built cleanly from the migration files** (columns, policies, triggers, functions, enum values, indexes, constraints);
- a partly present migration stops the chain with nothing changed; skipping ahead, re-running, recording something that is not there, and a failing migration are all refused or rolled back with no history row.

Not covered by the preflight, so it is covered by the rehearsal on the **restored real backup** (step 5): column-level differences on tables production already has.

## 3. The four "legacy" objects: no workaround, no weakened check
They are not legacy objects to recreate by hand. Applying **019 in order** creates them, then 023 drops them as designed. The preflight's "dropped names must exist" check stays exactly as it is; it is what caught the problem. Do not edit 023 or the check.

## 4. Duplicate serials (4 groups, 8 devices)
027 does **not** need them resolved first: it keeps every record, builds the serial registry, and lists the collisions (`serial_duplicate_candidates`, Access & Roles). The decisions are about which record is the real device:
- same laptop in both tables (stale copy from before laptops moved between them): keep the one that is assigned or has history; mark the other for removal after a physical check;
- same serial typed differently (case, spaces): the correct spelling stays;
- two genuinely different devices with one serial: one needs a corrected serial (a label check).
To decide **before** the window, run the probe: it prints, per group, only the serial, table, status, whether someone is assigned, last update and history rows (no names).

## 5. Admin two-factor, backup and rehearsal
- **MFA.** Migration 030 makes admin powers (roles, access removal, restore) require a two-factor session. The only admin has none. Before the window: confirm TOTP is ON in the Supabase dashboard. After the deploy: the admin signs in (editor-level access works with a password alone), opens **Security**, enrols an authenticator and confirms the page says the session is verified. Until then they cannot manage roles. Recommended: enrol, then promote and enrol a second admin so a lost phone never locks you out (recovery: the owner removes the factor in the dashboard).
- **Backup (needs your authorization).** Supabase restore point plus the app's **Export backup** (verified complete) handled as confidential.
- **Rehearsal on the restored backup** (needs the backup): `REHEARSAL_FILE=<backup> REHEARSAL_START=20260901000015_add_monitors_enum_value.sql REHEARSAL_MIGRATION=20260901000035_decommissioned_guard_rails.sql npm run test:db -- staging-copy`.

## Corrected production sequence
Every write step is performed by `scripts/production/apply-migration.mjs` (the Supabase CLI cannot: it does not run the 021 adaptation in the same transaction and would try to re-run the in-place migrations). Each step needs an `--execute` flag and your explicit go.
1. **Probe (read-only):** `powershell -ExecutionPolicy Bypass -File scripts\production\run-preflight.ps1 -Task probe`. Settles 017/018/020 and gives the duplicate facts.
2. **Plan (read-only):** `… -Task plan` prints exactly what the applier will do, in order, and stops on anything partial.
3. **Decisions** on the duplicates and the admins. *Your approval.*
4. **Backup, then rehearsal** on the restored copy. *Your authorization, then go / no-go.*
5. **Window (freeze):** `record` each in-place migration (history only), `apply` each missing one (019, 020 if absent), then 021–030, 033, 034, 035, **one at a time**, comparing rows after each. Roll back with `supabase/rollback/<version>_down.sql` in a transaction, or restore the restore point.
6. **Push the release branch, deploy, enrol the admin, smoke checks, final comparison.**
