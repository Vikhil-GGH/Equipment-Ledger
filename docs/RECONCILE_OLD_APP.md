# Old-app data vs production: read-only reconciliation

The live Pages app keeps data in each browser's `localStorage`. Before the cutover, check whether anything in it is missing from production. **Nothing here writes anywhere** (no database, no old app data).

1. **Export** (on every browser/computer where the old app was used): open `https://vikhil-ggh.github.io/Equipment-Ledger/`, F12 > Console, paste the contents of [scripts/reconcile/export-old-app.js](../scripts/reconcile/export-old-app.js), Enter. A JSON file downloads. It only reads `eqledger:*` keys.
2. **Compare** (offline, uses the backup folder, not the database):
   ```
   node scripts/reconcile/compare-old-app.mjs --old <export1.json> [--old <export2.json>] --backup "%USERPROFILE%\EquipmentLedger-prod-backup-2026-10-22" --out "%USERPROFILE%\EquipmentLedger-reconcile"
   ```
   `--out` must be outside the repo (refused otherwise). It writes `reconciliation.md/.json` and `import-candidates.xlsx`.
3. **Read the report.** Serials are matched with the database's own rule.
   - *same*: nothing to do. *only in database*: informational.
   - *only in old app*: import candidates → `import-candidates.xlsx`, loaded through the app's import wizard (adds only).
   - *changed* (status / assignee / location differ) and *duplicates*: a person decides per item; imports never change existing devices, and no tool applies them.
   - Leave of Absence and other judgement cases stay manual.
4. **Approval:** any import is a business-data decision for the owner.

Tested on synthetic data and on the real backup (offline) in `scripts/reconcile/reconcile-core.test.ts`.
