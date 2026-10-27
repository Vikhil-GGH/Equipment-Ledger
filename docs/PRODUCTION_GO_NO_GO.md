# Production go / no-go checklist

**Status:** draft for the owner's decision. Nothing here has been run against production. One unchecked box under a **STOP** item is a no-go. Sources: [PRODUCTION_WINDOW_RUNBOOK.md](PRODUCTION_WINDOW_RUNBOOK.md), [DEPLOY_GITHUB_PAGES.md](DEPLOY_GITHUB_PAGES.md), [RECOVERY_OPTIONS.md](RECOVERY_OPTIONS.md), [RECONCILE_OLD_APP.md](RECONCILE_OLD_APP.md), [PRODUCTION_REHEARSAL_RUNBOOK.md](PRODUCTION_REHEARSAL_RUNBOOK.md).

Record on the day: date/time ______  release commit id ______  backup folder ______  restore point time ______

## 0. Already done (not repeated)
- Production backup `EquipmentLedger-prod-backup-2026-10-22` and the 18-step migration rehearsal on its restored copy (2026-10-22): passed; no pre-existing column of any row changed; rollbacks 035 to 029 verified.
- Old-app reconciliation: the real export was compared with the production backup, the review workbook was completed, and **51 assignments were approved** (46 in `serialized_assets`, 5 in `active_laptops_np`). CND4420J3Z stays excluded (needs investigation). 9 rows keep production's value, 7 need investigation, the 4 duplicate groups stay untouched.
- Guarded assignment applier: `scripts/production/assignment-core.mjs`, `apply-assignments.mjs`, `run-assignments.ps1`. It was rehearsed on the restored backup with the whole migration chain applied. The guard rails (count mismatch, excluded serial) refuse, the dry run rolls back and leaves the data identical, the execute run applies 51 and checks them, and a second run is refused.

## 1. Decisions (owner)
- [ ] The 4 duplicate-serial groups (8 devices) are acknowledged. The migrations list them and never merge; each is decided after the window.
- [ ] Two admins are named and each has a phone ready to enrol an authenticator.
- [ ] The other users are told the freeze time: no edits, imports, onboarding or offboarding until the owner ends it.
- [ ] Confirmed that no other build of the new app is live against the production database.
- [ ] Nobody has entered data in the old app since the export, or it has been re-exported. Otherwise the approved 51 are stale.

## 2. Recovery capability
- [ ] **STOP** Supabase Dashboard > Database > Backups checked: plan ______, PITR on/off ______, latest restore point ______.
- [ ] If there is no PITR or restore point, the owner has accepted the reduced recovery: the verified rollbacks 035 to 029 plus fix-forward only. Or PITR is enabled first.
- [ ] Dashboard Auth: TOTP multi-factor ON, anonymous sign-ins OFF, sign-ups as decided.
- [ ] GitHub Settings checked before any push: Webhooks (none or Pages only), GitHub Apps (no Vercel/Netlify/Render), Pages Source = `main`.
- [ ] **STOP** `release/v2` and the `legacy-main` tag are pushed. Verified 2026-10-27 with `git ls-remote origin`: the remote has only `main` (`d7bd7ac`), so **neither has been pushed** and the earlier Git authentication failures stand. Push needs working GitHub credentials, and the owner's approval.

## 3. Evidence that must be current (re-run on the day)
The rehearsal used the 2026-10-22 backup. Anything entered in production since then makes that backup stale.
- [ ] **STOP** `run-preflight.ps1 -Task compare -BackupDir $B` ends "Every pre-existing table equals the backup". If a table differs, take a new backup and re-run the rehearsal on it before continuing.
- [ ] **STOP** `run-preflight.ps1 -Task plan` shows the same 18 steps: apply 015, record 016, apply 017–020, 021–030, 033–035. Anything else is a no-go.
- [ ] `-Task preflight` has no unresolved STOP.
- [ ] A fresh `-Task backup` was taken immediately before step 1 and its hashes verified.
- [ ] Tests green on the release commit (unit and db suites, run today), and `verify-build.mjs release-dist --production-ref jhwhftaffsjulrvtajnl` passes. Both are on the commit that will be deployed.
- [ ] The commit to deploy is the one rehearsed, and `gh-pages` was built from it. Record the commit ids; the frontend changed in no commit since the build, but rebuild with `prepare-pages-branch.mjs` if in doubt, and move `release/v2` to the final commit before pushing.

## 4. Window (go at each gate)
- [ ] Freeze announced and in effect.
- [ ] Each of the 18 steps is applied one at a time with `run-apply.ps1`. The compare is clean after every step, and the project reference and password prompts are answered by the owner.
- [ ] Stop rule: any error, any ✖, or any plan line other than the next expected step means stop and use the recovery table in RECOVERY_OPTIONS.md.
- [ ] After the last step: `-Task preflight` (nothing pending), `-Task probe`, final compare, then a post-migration backup.
- [ ] Assignments (after the last migration, before the post-migration backup): `run-assignments.ps1 -ChangeList <change-list.json> -Expect 51` as a dry run, then the same with `-Execute`. It acts as the single active admin, refuses any device that is no longer available and unassigned, and rolls back everything on any failed check. Afterwards 51 devices read `provided` and the device totals are unchanged.

## 5. Cutover (point of no return is ending the freeze)
- [ ] Push `gh-pages`. This does not deploy.
- [ ] Switch Pages Source to `gh-pages` and `/ (root)`.
- [ ] Supabase URL Configuration: Site URL and Redirect URLs set to the Pages address, per DEPLOY_GITHUB_PAGES.md.
- [ ] Validation with the freeze still on:
  - [ ] Owner signs in; Overview, Laptop Inventory, Onboarding/Offboarding, Active Employees, Bulk Stock and Export backup all work.
  - [ ] Admin enrols an authenticator and Security shows "verified"; the second admin is enrolled too.
  - [ ] Row counts match the post-migration backup (468 rows pre-existing), and the 51 assigned devices show their assignees.
- [ ] Only now: end the freeze.
- [ ] If validation fails: Pages Source back to `main`, and decide the database per RECOVERY_OPTIONS.md phase 2.

## 6. After
- [ ] Decide the 4 duplicate-serial groups under Access & Roles.
- [ ] Keep the window's backups through the retention period, then destroy them and log it.

## Recommendation rule
- **GO** only if every **STOP** box is checked and sections 2 and 3 are checked.
- **NO-GO** on any unchecked STOP, any compare difference, or no known restore path that the owner hasn't accepted in writing.
