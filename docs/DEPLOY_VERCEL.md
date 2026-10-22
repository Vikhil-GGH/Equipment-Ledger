# Deploying to Vercel (prepared; nothing deployed)

The app is a static single-page bundle (`npm run build` → `dist/`). `vercel.json` in the repository root holds the settings: build command, output folder, single-page rewrite (every path serves `index.html` so deep links such as `/laptops` work), security headers (camera allowed for the scanner only), long caching for hashed assets and no caching for `index.html` / the service worker (so updates reach users).

## Before anything is deployed
**1. The GitHub `main` is a different, older version of this app** (17 commits from August, no `supabase/migrations`). It shares no history with this work. If a Vercel project is already connected to that repository and deploys `main`, **pushing or merging into `main` would deploy the new app against a production database that has not been migrated yet**, and break it.
- Push the new work to a **new branch only** (proposed: `release/v2`), never to `main`, until cutover.
- In Vercel: set *Production Branch* to a branch that does not receive pushes yet, or turn off automatic deployments, until the cutover step in [PRODUCTION_RELEASE_SEQUENCE.md](PRODUCTION_RELEASE_SEQUENCE.md).
- Replacing `main` with the new history later is a **force push (destructive)**, or a merge with `--allow-unrelated-histories`; either needs the owner's explicit approval. Preferred: keep the old `main` as a tag (`legacy-main`) first.

**2. Environment variables** (Vercel → Project → Settings → Environment Variables, **Production scope only**):
| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | the production project URL (`https://jhwhftaffsjulrvtajnl.supabase.co`) |
| `VITE_SUPABASE_ANON_KEY` | the production **anon/publishable** key (public by design) |

Never set a `service_role` key, a database password or any staging value here. Staging builds are refused by the build itself, and the bundle was checked: no staging reference, no secrets.

**3. Supabase Auth settings** (Dashboard → Authentication → URL Configuration): *Site URL* = the final app address and *Redirect URLs* include it, or password-reset emails will point to the wrong place. Anonymous sign-ins stay OFF; TOTP stays ON.

**4. Node version.** `package.json` pins `engines.node >= 22.12` (what the build tool needs); Vercel reads it.

## Cutover order (summary)
Migrations are applied and verified first (one at a time, with the rollback ready) → push the release branch → deploy the build from that exact commit → admins enrol an authenticator → smoke checks. Recovery is coordinated as described in [DEPLOY_GITHUB_PAGES.md](DEPLOY_GITHUB_PAGES.md) (GitHub Pages is the chosen host; this file is for a possible later move).

## Not included on purpose
A strict Content-Security-Policy: it needs testing against the camera scanner and the Supabase endpoints in a preview first. Add it after the first deployment as its own change.
