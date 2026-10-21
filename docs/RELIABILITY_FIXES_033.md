# Reliability and data-accuracy fixes: migration 033

**Status:** written and tested locally. **Not applied to hosted staging or production.** Migration 030 stays the security baseline; nothing here adds security features.

Found by the 2026-10-21 browser checks on staging (which is on 030). One small migration, `supabase/migrations/20260901000033_reliability_fixes.sql` (numbered 033 so it can't be confused with the retired, archived 031), plus a few front-end changes.

## What was wrong and what changed

| # | Problem | Root cause | Fix |
|---|---|---|---|
| 1 | Bulk Stock actions on a missing item failed with a foreign-key error | `perform_bulk_action` checked `FOUND` after `EXECUTE`, which never sets it, so it read a stale value left by the earlier role lookup (the same trap that broke 031) | The row is locked with `PERFORM … FOR UPDATE` and checked explicitly, for all seven actions: "Bulk item not found". Everything else is unchanged |
| 2 | A laptop kept by its employee with approval showed as a register mismatch forever | By design the device stays *Provided* and assigned, and its register row closes as `retained_authorized`. `equipment_register_mismatches` only accepted an *open* row | The view also accepts a `retained_authorized` row when it is the device's **latest** register row and the device is still assigned to that same person. Anything else (a different person, no row at all, an open row for someone else) is still reported |
| 3 | Assignee names were stored as typed (`"  zz   IMPORTBETA "`) | Nothing tidied `devices.assigned_to` | A `BEFORE INSERT/UPDATE OF assigned_to` trigger on the four device tables trims, collapses spaces, and uses the employee's recorded name when exactly one employee matches. Only values being inserted or changed are touched; employee ids and register history are not |
| 4 | Assigning a device to a name shared by two employees recorded no link, silently | `sync_equipment_register` stored `employee_ambiguous = true` with no employee | It now refuses, saying what to do (issue from the employee's Onboarding page, which names the employee, or make the names different). Old unlinked rows are left as they are |
| 5 | The issue picker offered Retained and Decommissioned laptops | The query allowed the statuses the device-page "Provide" allows | Picker lists **Available only** (laptops and headsets); `issue_equipment` also refuses a device that isn't Available. The device-page Provide rules are unchanged |
| 6 | Two in-progress offboarding checklists for one employee; the Excel export counted the employee's pending items twice (13 vs the dashboard's 10) | Nothing prevented the duplicate; the export attached the employee's equipment to every record | A `BEFORE INSERT / UPDATE OF employee_id` trigger refuses a second **in-progress** checklist for the same person. It first takes transaction-scoped advisory locks (employee id, the employee record's name, the typed name, always in ascending key order so sessions can't deadlock), then checks, so two simultaneous requests can't both pass: the second waits, then is rejected after the first commits or proceeds after it rolls back. Linked and unlinked records for the same person can't slip past each other. Completed ones never block, existing duplicates are untouched. The export counts an employee's equipment once, on their newest record |
| 6b | Device-page Provide of a set-aside (Retained / Decommissioned) device | It only checked the status | `perform_lifecycle_action` (replaced, otherwise identical to 030, history unchanged) now also requires the device to be unassigned (so not under an authorized retention) and to have no open register issue (so never a second open issue). The register path stays Available-only |
| 7 | Add employee form accepted a second person with the same name without a word | The Excel import had a duplicate check; the form did not | The form uses the **same finder** as the Excel preview (`duplicateFinder`), shows who may be the same person and why, and asks. Nothing is merged. "Leave of Absence" is still flagged for review, never mapped |

## Database objects

Replaced (`create or replace`, same signatures, grants unchanged): `perform_bulk_action`, `sync_equipment_register`, `issue_equipment`, `perform_lifecycle_action`, view `equipment_register_mismatches`.
Added: functions `canonical_assignee(text)`, `normalize_device_assignee()`, `prevent_duplicate_offboarding()` (execute revoked from everyone but the owner); triggers `serialized_assets_normalize_assignee`, `active_laptops_np_normalize_assignee`, `monitors_normalize_assignee`, `other_equipment_normalize_assignee`, `offboarding_one_in_progress`.
No table, column, row, policy or grant changes.

## Existing-data compatibility (proved on a copy of staging)

`supabase/tests/db/staging-copy-rehearsal.db.test.ts` loads a read-only snapshot of staging (605 rows, 20 tables) into a disposable database at 030, applies 033, then rolls it back:
- every table hash is identical after 033 and after the rollback (no existing row, including `test2`, the audit history and the ZZ accounts, changes);
- the mismatch list is identical before and after (0 rows);
- the legacy duplicate offboarding pair (Test Employee 01) is kept; a new one for that employee is refused while one is in progress;
- the shared name `zz browseralpha1021` is refused on assignment instead of being silently unlinked.

On staging today: 27 assigned devices, none with untidy text (so rule 3 rewrites nothing); 1 `retained_authorized` row; 0 mismatches; 2 register rows already unlinked (history, left as they are); 1 retained laptop that the old picker offered.

## Rollback

`supabase/rollback/20260901000033_down.sql` restores the 030 definitions exactly (the three functions and the view) and drops what 033 added. No data is touched. A test proves the restored function text and view equal a database that never had 033. Run it in a transaction.

## Tests

`reliability.db.test.ts` (32), `bulk-stock.db.test.ts` (17), the rehearsal (6, opt-in with `REHEARSAL_SNAPSHOT=<label>`), `offboarding-race-live.db.test.ts` (two real connections, hosted staging only, opt-in with `RACE_TEST=1`), `issuableDevices.test.tsx`, `EmployeeModal.test.tsx`, and an export test for the dashboard agreement. Each fix's test fails without the fix.

## Hosted staging: what needs approval

Nothing has been run there. The proposed sequence is in the project report; in short: snapshot, dry-run (`staging:migrate -- --dry-run` must list only 033), apply 033, compare every record, run the rolled-back SQL suite, verify and smoke, then repeat the browser workflows on synthetic records.
