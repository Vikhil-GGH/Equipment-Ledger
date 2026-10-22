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

## Cutover (after the migrations succeed; each step needs your go)
1. Build and verify from the release commit (commands above).
2. Create the deploy branch from the verified `release-dist` (an orphan `gh-pages` branch containing only those files) and push **that branch** (this does not deploy while Pages still serves `main`).
3. **Switch** GitHub > Settings > Pages > Source to branch `gh-pages`, folder `/ (root)`. The new app is live within about a minute.
4. Supabase Dashboard > Authentication > URL Configuration: **Site URL** `https://vikhil-ggh.github.io/Equipment-Ledger/`, **Redirect URLs** include `https://vikhil-ggh.github.io/Equipment-Ledger/**`; anonymous sign-ins OFF; TOTP ON.
5. Smoke test in the app, then the admin enrols the authenticator (Security page).

## Rollback of the deployment (instant, no data involved)
Settings > Pages > Source back to branch `main`: the old app is served again within a minute (`main` is untouched; `legacy-main` marks it). Note the old app cannot work against the migrated database; if the migration itself must be undone, use the migration rollback/restore procedure in the window runbook first.

## Vercel
`vercel.json` stays in the repository for a possible later move to Vercel (it serves from `/`, the default build). It is inert on GitHub Pages and is not used by this plan.
