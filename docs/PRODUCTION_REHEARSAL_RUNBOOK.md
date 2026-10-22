# Production rehearsal and read-only preflight: runbook

**Status:** prepared, **not run**. Nothing here connects to production. Every step that does needs the owner's explicit go-ahead ([PRODUCTION_MIGRATION_PLAN.md](PRODUCTION_MIGRATION_PLAN.md) has the approval checkpoints CP0–CP8).

The chain to apply is **021–030, 033 and 034** (whatever the preflight shows as pending). 031 and 032 are discontinued and archived; they are not part of any production step.

## What is already proved (staging, synthetic and real-copy)
- Every migration applies in order on a fresh database, and 033/034 apply and roll back **exactly** on a copy of real staging data, with no existing row changed.
- 033 and 034 are applied on hosted staging with row-level comparison, SQL (73), verification (16/16), smoke (51/51) and browser tests passing.
- Excel import, duplicate handling and screen lists are tested beyond 1,000 rows (below).

> **Update:** the preflight has been run; see [PRODUCTION_PREFLIGHT_FINDINGS.md](PRODUCTION_PREFLIGHT_FINDINGS.md). Next read-only steps: `run-preflight.ps1 -Task probe`, then `-Task plan`.

## Step 1: the read-only preflight (the owner runs it, from a trusted machine)
```
PREFLIGHT_DB_URL='postgresql://…' PREFLIGHT_DB_SSL_CA=certs/supabase-prod-ca.crt node scripts/production/preflight.mjs
```
It never writes (one `READ ONLY` transaction, rolled back) and verifies the server certificate. It reports which of 021–034 are already applied, STOPs on anything a migration would trip over (hand-made objects, shared emails/serials/Bulk Stock names), and lists the admins and their authenticators. Decisions are made only on the real findings. **Send back the report; it contains no secrets.**

## Step 2 (current): the verified production backup and the rehearsal
**Backup (read-only on the database; writes a NEW local folder):**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\production\run-preflight.ps1 -Task backup -OutDir "$env:USERPROFILE\EquipmentLedger-prod-backup-2026-10-22"
```
- One REPEATABLE READ, READ ONLY transaction: every table is read at the same instant. TLS verified; nothing written to the database.
- The folder (outside the repository, refused otherwise) holds `data.json` (all rows), `signature.json` (the complete schema), `manifest.json` (row counts, per-table content hashes, migration history, SHA-256 of the files) and `SHA256SUMS.txt`. It contains personal data: keep it on an encrypted disk (BitLocker), never in the repository, chat or email.
- It verifies itself (files re-read, SHA-256, every table's row count); you can re-check with `Get-FileHash`.
- Also note the Supabase dashboard restore point (Database > Backups) as the second recovery path.

**Rehearsal on the restored copy (offline, no network):**
```powershell
$env:REHEARSAL_DIR = "$env:USERPROFILE\EquipmentLedger-prod-backup-2026-10-22"; $env:REHEARSAL_PRESENT = "16"
node node_modules\vitest\vitest.mjs run --config vitest.db.config.ts supabase/tests/db/production-backup-rehearsal.db.test.ts
```
It requires, in order: files intact; production's schema **identical** to the expected 001–014 + 016; restored rows identical (count and content hash per table); the plan equals production's; **no pre-existing column of any pre-existing row changes at any of the 18 steps**; the final schema equals a clean build; rollbacks 035 to 029 applied in reverse leave rows untouched and the schema equal to the state after 028. Going back further is deliberately not automatic: 029 keeps a private backup table of employee history (a rollback never deletes data), which blocks dropping 028's types; that would be a deliberate, approved removal, and the restore point covers it.

## Step 2 (earlier text, kept for reference): a restore-tested backup
Follow "Backups: encrypted handling" in the migration plan. For the rehearsal below the most convenient file is the app's own **Export backup** (Data page, signed in with the two-factor code): a single JSON with every table, verified complete by the app (it refuses to write a partial file). Handle it as confidential: encrypted disk, never in the repository, chat or email.

## Step 3: rehearse on a copy (no network, on the trusted machine)
Load the backup into a disposable in-process database, apply the pending chain to it, then apply and roll back the last migration:
```
REHEARSAL_FILE=D:/secure/prod-backup.json ^
REHEARSAL_START=<first pending migration file name, from the preflight> ^
REHEARSAL_MIGRATION=20260901000034_onboarding_assign_device_rules.sql ^
npm run test:db -- staging-copy
```
- The copy is loaded **exactly** (every row), at the state just before `REHEARSAL_START`.
- Each migration from START to the one before the rehearsed one is applied; the tables each changed are printed (some earlier migrations legitimately backfill, e.g. 026 builds the register).
- The rehearsed migration (034 by default) must change **no** existing row, and its rollback must restore the copy **exactly**.
- Failures stop the plan. Typical causes are listed by the preflight (duplicates, hand-made objects).

Also rehearse the earlier ones one by one if the preflight shows they are pending: run the command again with `REHEARSAL_MIGRATION` set to each file in turn (and `REHEARSAL_START` unchanged), reading the "rows changed" lines.

## Step 4: go / no-go (CP3), all must be true
1. Preflight clean (no unresolved STOP), duplicates decided.
2. Backup restored and row counts equal the preflight's.
3. Rehearsal passes for the whole chain; rollbacks verified.
4. Two admins decided and ready to enrol an authenticator.
5. Maintenance window and freeze announced; restore point noted.
6. The commit to deploy is the one rehearsed (record its id).

## Window (summary; details in the plan)
Freeze → fresh restore point → apply **one migration at a time** with the Supabase CLI, comparing every pre-existing row after each (staging's `snapshot compare` is the model; on production use the logical copy) → deploy the frontend from the same commit → admins enrol → smoke checks → final comparison. Stop at any unexpected difference; roll back with the matching `supabase/rollback/*_down.sql` inside a transaction, or restore the restore point.

## Volume and performance (synthetic data)
| Area | Result |
|---|---|
| Asset import, 3,000 laptops | 1.7 s in-process; all created; a repeat of the same file creates nothing (3,000 unchanged) |
| Case/space-different serials, laptops already in Active Laptops | Treated as the same device; no second copy |
| Import never changes status or assignee of an existing device | Tested |
| Bulk Stock import, 1,500 items | 0.3 s; repeating the file is blocked; a confirmed second delivery adds the quantities |
| Active Employees import, 2,500 rows; preview of 3,000 | Tested (existing tests; preview under 3 s) |
| Spreadsheet write/parse, 5,000 rows | 70 ms / 130 ms |
| Backup, exports, laptop list | Complete beyond 1,000 rows (existing paging tests) |
| **Fixed in this pass:** Monitors, Other Equipment, Bulk Stock, Onboarding and Offboarding lists, the issue picker and the import preview's Bulk Stock lookup | They stopped silently at 1,000 rows; now read in full, with tests at 1,100–2,600 rows |

Known and acceptable: a duplicate serial *inside one file* is flagged and skipped by the preview; if the preview were bypassed, the server would apply the second occurrence as an update of the first. Spreadsheet speed on a slow machine is not a concern at these sizes; the real limit is the 16 MB request size, far above a 5,000-row file.
