# Release and deployment on GitHub Pages (prepared; nothing pushed or deployed)

## What was verified about the hosting (2026-10-22)
| Fact | Evidence |
|---|---|
| The live app is `https://vikhil-ggh.github.io/Equipment-Ledger/` (a project site under a **sub-path**) and is a single-file static app (`index.html`, `sw.js`, manifest, icons, `.nojekyll`) | HTTP 200 on that address; `origin/main` tree |
| It is served by **GitHub Pages from `main`**: the only workflow is the built-in `pages-build-deployment`; all 5 latest deployment records are environment `github-pages`, ref `main` | GitHub API |
| No Vercel, Netlify or other deployment records, and no commit statuses from any host | GitHub API (deployments, commit status) |
| No `.github/` workflows on `main`, none on our branch | trees |
| `main` is **not** protected; no rulesets | GitHub API |
| The repository is **public** | GitHub API |
| History scan (all 58 commits, 74k lines): no tokens, keys, passwords or database URLs; emails are fake examples. Commit **author metadata** (the owner's email) becomes public too | scan |
| **Not verifiable without repository-admin access:** webhooks, the Pages source setting, installed GitHub Apps | needs Settings access |

## Why pushing `release/v2` cannot deploy
The only deployment mechanism present is Pages building from `main`. A push to another branch does not trigger it, and the release branch contains no workflow files. Residual risk: an undeclared webhook (not visible without admin access). **Owner check before the push, about two minutes:** GitHub > Settings > *Webhooks* (expect none or only Pages), *Integrations / GitHub Apps* (no Vercel/Netlify/Render), *Pages* (Source = branch `main`). Then the push of that single branch is safe.

## Preserve `main`
`legacy-main` is a local tag on `main`'s current commit (`d7bd7ac`). It is pushed with the release only if you say so (a tag push does not deploy either). `main` itself is never force-pushed or merged with unrelated history by this plan.

## The release (what gets built and how it is served)
- The app is built with base path `/Equipment-Ledger/` (`node scripts/release/build-pages.mjs`): assets, router, PWA manifest and icons all work under the sub-path; `404.html` is a copy of `index.html` so deep links (`/laptops`) load the app; `.nojekyll` included.
- The production Supabase URL and public anon key are baked in at build time from `.env` (GitHub Pages has no environment variables). `node scripts/release/verify-build.mjs release-dist --production-ref jhwhftaffsjulrvtajnl` checks: correct base path, 404.html, service worker, manifest, no staging reference, no password/service key, exactly one Supabase project and it is production. **Verified: all checks pass.** Tested in a real browser under the sub-path (root and two deep links boot the app and stay under `/Equipment-Ledger/`; no request outside the path; no call to Supabase from the test).
- Same address as today, so users, bookmarks, the installed PWA and the Supabase Auth settings do not change. The new `sw.js` replaces the old one at the same URL; after the cutover a reload (or reopening the app) picks it up.

## What the live app actually is (this changes the recovery plan)
**The current GitHub Pages app (`main`) never talks to Supabase.** It is a single-file app that keeps its data in each browser's `localStorage` (its only network contacts are Google Fonts and one CDN). Consequences:
- The production database migration does **not** affect the live Pages app at all, in either direction. Reverting Pages to `main` is therefore technically safe with respect to the database, whatever state the database is in.
- The coupling is **business data**, not code: after the cutover people work in the new app (data in Supabase); the old app's browser-local data stays where it is, untouched, but becomes stale. Rolling the app back after people have worked in the new one shows them stale data, and rolling the database back loses their new work. **They must be treated as one decision.**
- Each browser's old data is separate (one operator's browser is not another's), so the new database is the only place the 2–3 users can share data.

## Coordinated recovery (app and database decided together)
Three phases; the **point of no return is the first real work done in the new app**.
| Phase | Situation | App (Pages source) | Database | Data at risk |
|---|---|---|---|---|
| 1. Migrations running | A step fails or a compare shows a difference | Stays on `main` (unaffected) | Stop. Roll back the last step only if verified (035 to 029), else fix forward; restore point only as the last resort | None: nobody works in the new app yet |
| 2. Validation (new app deployed, **freeze still on**, only the owner smoke-tests) | A real problem is found | Source back to `main` | Return to the pre-migration state **only if** the restore point exists (below); otherwise fix forward | Only the owner's test entries |
| 3. In real use | A problem appears after people have worked | **Do not revert the app** (the old app's data is stale) | **Fix forward**: patch the app (a new commit on `gh-pages`), use the verified rollbacks only for 035 to 029 and only after a fresh backup | Restoring would lose their work |
So the freeze must not end until validation passes, and ending it is the point of no return. Before then, rollback is cheap; after it, recovery is forward.

**Database restore point: must be confirmed before the window.** The plan relies on Supabase's own restore for phase 2. Check Dashboard > Database > Backups: which plan, whether **Point-in-Time Recovery** is on, the time of the latest backup. If there is no restore capability, the only recovery before the point of no return is the verified rollbacks (035 to 029) plus fix-forward; our logical backup restores into a disposable database for rehearsal, **not** into production. In that case say so before the window and decide whether to enable PITR first.

## Cutover (after the migrations succeed; each step needs your go)
1. **Build and verify** from the release commit (`node scripts/release/build-pages.mjs`, then `verify-build.mjs`). **Prepared:** the local branch `gh-pages` is an orphan branch holding the verified build (20 files); `origin` has no `gh-pages` branch (verified: its only ref is `main`), so the name is unused. Rebuild with `prepare-pages-branch.mjs` if the release commit changes.
2. **Push** the `gh-pages` branch (does not deploy: Pages still serves `main`).
3. **Switch** GitHub > Settings > Pages > Source to branch `gh-pages`, folder `/ (root)`. Live within about a minute at the same address. These two steps are what "deploy immediately after the migrations" means: nothing else is needed.
4. Supabase Dashboard > Authentication > URL Configuration: **Site URL** `https://vikhil-ggh.github.io/Equipment-Ledger/`; **Redirect URLs** include `https://vikhil-ggh.github.io/Equipment-Ledger/**`; anonymous sign-ins OFF; TOTP ON.
5. **Validation (freeze on):** the owner signs in, smoke-tests, the admin enrols the authenticator (Security page). Only then end the freeze.

## Rollback of the application
Settings > Pages > Source back to branch `main`: the old app is served again within a minute (`main` is untouched; `legacy-main` marks it). Use it in phase 2 only, together with the database decision above. The old app needs no database; its browser-local data is exactly as it was.

## Open question for the owner (blocks the cutover, not the migrations)
**Is the old app's data already in the production database, and is anyone still entering data in the old app?** The production database holds 57 inventory laptops, 114 active laptops, 31 monitors and 3 imports; the old app has built-in importers for "Tampa laptops / monitors / Next Perimeter laptops", which suggests that data was loaded from it. If anything was entered in the old app after that load, it must be exported and imported into the new app before the cutover (the old app has no generic export, so this needs a plan). Also confirm that **no other deployment of the new app (an earlier build) is live anywhere against the production database.**

## Vercel
`vercel.json` stays in the repository for a possible later move to Vercel (it serves from `/`, the default build). It is inert on GitHub Pages and is not used by this plan.
