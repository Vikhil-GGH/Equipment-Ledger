# Recovery options, with and without Supabase Point-in-Time Recovery

Nothing here has been run against production. Coordinated app + database model: [DEPLOY_GITHUB_PAGES.md](DEPLOY_GITHUB_PAGES.md). Exact commands: [PRODUCTION_WINDOW_RUNBOOK.md](PRODUCTION_WINDOW_RUNBOOK.md).

## What exists today
| Asset | State |
|---|---|
| Logical backup `EquipmentLedger-prod-backup-2026-10-22` (12 tables, 468 rows, hashes verified) | Exists, outside the repo. Restores only into a **disposable** database (rehearsed). Not a production restore tool. |
| Verified rollbacks 035 → 029 (`run-apply.ps1 -Rollback`) | Rehearsed on the real backup; rows unchanged; schema returns to the post-028 state. Not possible before 029. |
| Old app on GitHub Pages `main` (`legacy-main` tag, local) | Untouched; needs no database; its data lives in browsers. |
| Supabase PITR / dashboard backups | **Unknown. Owner must check** Dashboard > Database > Backups (plan, PITR on/off, latest backup time). |

## Decision by phase
| Phase | Problem | With PITR / a dashboard restore point | Without PITR |
|---|---|---|---|
| 1. Migrations running (nobody uses the new app; old app unaffected) | A step fails or a compare differs | A failing step already rolls back by itself. For a bad *completed* step: 029+ → `-Rollback` (one at a time). Restore to the point just before the window only as a last resort. | Same self-rollback and `-Rollback` for 035–029. For steps before 029 (015–028): **fix forward** (the schema is purely additive for existing rows, proven: no existing column changed), or build a new project (below). |
| 2. Validation (new app live, freeze on, only the owner tests) | Real defect found | Pages Source back to `main`; restore to the pre-window point (only the owner's test entries are lost). | Pages Source back to `main` (safe, old app needs no DB). Database stays migrated: harmless to the old app; fix forward and redeploy. |
| 3. Real use | Defect after people worked | **Do not restore** (loses their work) and do not revert the app. Fix forward; PITR only for data corruption, to a point just before it, accepting loss after it. | Fix forward. `-Rollback` 035–029 only after a fresh backup. For corruption: repair rows from the latest backup/exports by hand. |

The point of no return is ending the freeze.

## Fallback without any restore: a new Supabase project
If production is ever unusable and there is no PITR: create a new project, apply the migration chain from the repo (`supabase/migrations`, verified clean-build), load the rows from the newest verified backup (`data.json`; the rehearsal harness already does exactly this on a disposable database), set the new URL/anon key in `.env`, rebuild (`build-pages.mjs`, `verify-build.mjs --production-ref <new ref>`), redeploy. **Not covered by a backup, so rebuilt by hand:** Auth users and their MFA enrolments (users re-register; admins re-enrol), dashboard Auth settings. Status: designed, **not rehearsed end to end**.

## Recommended, before the window
1. Check the dashboard; if there is no PITR/daily backup, decide whether to enable one (paid plan) before migrating.
2. Take a fresh `-Task backup` immediately before step 1 and after the last step.
3. Keep the freeze on until validation passes.
