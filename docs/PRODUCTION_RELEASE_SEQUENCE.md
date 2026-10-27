# Production release sequence (prepared; nothing here has been run against production)

Companion to [PRODUCTION_MIGRATION_PLAN.md](PRODUCTION_MIGRATION_PLAN.md) (checkpoints CP0–CP8) and [PRODUCTION_REHEARSAL_RUNBOOK.md](PRODUCTION_REHEARSAL_RUNBOOK.md). Chain to release: **021–030, 033, 034, 035** (only the ones the preflight shows pending). 031 and 032 are archived and never run.

## Where we are (updated 2026-10-27)
| Item | State |
|---|---|
| Code, migrations, rollbacks, tests | Done, committed locally (branch `security/anonymous-access`), proved on staging |
| Release bundle | Builds and verifies; local branch `gh-pages` holds it (see [DEPLOY_GITHUB_PAGES.md](DEPLOY_GITHUB_PAGES.md)) |
| Read-only production preflight | **Done** (2026-10-22): [PRODUCTION_PREFLIGHT_FINDINGS.md](PRODUCTION_PREFLIGHT_FINDINGS.md) |
| Production backup and rehearsal | **Done** (2026-10-22): 18 steps rehearsed on the restored backup, rollbacks 035 to 029 verified ([PRODUCTION_WINDOW_RUNBOOK.md](PRODUCTION_WINDOW_RUNBOOK.md)) |
| Old-app reconciliation | **Done**: 51 assignments approved, CND4420J3Z excluded ([RECONCILE_OLD_APP.md](RECONCILE_OLD_APP.md)) |
| Assignment applier | **Implemented and rehearsed** on the restored backup (`run-assignments.ps1`); not run on production |
| Production migrations | **Not run** |
| Git push | **Nothing pushed.** `origin` holds only `main`; `release/v2` and `legacy-main` are local (verified with `git ls-remote`) |
| Deployment | GitHub Pages from `main` today; cutover = push `gh-pages` and switch the Pages source (see DEPLOY_GITHUB_PAGES.md) |

Final checks and decisions: [PRODUCTION_GO_NO_GO.md](PRODUCTION_GO_NO_GO.md).

## Inputs I need
1. **Production database password** at each production step (typed hidden into the launcher scripts; never pasted into chat).
2. **Working GitHub credentials** for the push of `release/v2`, `legacy-main` and `gh-pages`.
3. **Owner checks that need dashboards:** Supabase backups / PITR, GitHub Settings (webhooks, Apps, Pages source).

## Sequence (each arrow is a gate)
1. ~~Preflight~~, ~~decisions~~, ~~backup~~ and ~~rehearsal~~: done on 2026-10-22. Re-run the compare and the plan on the day (the data may have moved since).
2. ~~Old-app reconciliation~~: done.
3. **Go / no-go** ([PRODUCTION_GO_NO_GO.md](PRODUCTION_GO_NO_GO.md)) → my recommendation, *your decision.*
4. **Freeze, then migrations one at a time** with `run-apply.ps1` (the Supabase CLI cannot run the 021 adaptation; compare to the backup after each) → *Your approval of the window; each migration is a production change.*
5. **Assignments** (`run-assignments.ps1`, dry run then `-Execute`) → *Your approval.*
6. **Push the commit, then deploy the bundle built from that same commit** → *Your approval.*
7. **Admins enrol an authenticator, smoke checks, final comparison, end the freeze.**

## Rollback
Per migration, `supabase/rollback/<version>_down.sql` inside a transaction (each proved exact on a restored copy), or restore the restore point; redeploy the previous frontend. The freeze means nothing is lost between them.
