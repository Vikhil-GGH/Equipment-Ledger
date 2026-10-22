# Production release sequence (prepared; nothing here has been run against production)

Companion to [PRODUCTION_MIGRATION_PLAN.md](PRODUCTION_MIGRATION_PLAN.md) (checkpoints CP0–CP8) and [PRODUCTION_REHEARSAL_RUNBOOK.md](PRODUCTION_REHEARSAL_RUNBOOK.md). Chain to release: **021–030, 033, 034, 035** (only the ones the preflight shows pending). 031 and 032 are archived and never run.

## Where we are
| Item | State |
|---|---|
| Code, migrations, rollbacks, tests | Done, committed locally (branch `security/anonymous-access`, 43 commits ahead of `main`), proved on staging (SQL 73, verify 16/16, smoke 51/51, browser) |
| Release bundle | Builds; 18 files, 1.7 MB; points only at the production project; **0 staging references**; no secrets (only the public client key) |
| Read-only production preflight | **Not run.** Needs a production database connection string (below) |
| Production backup / rehearsal / migrations | Not started; each needs its own approval |
| Git push | **No remote is configured** in this repository, so there is nothing to push to yet |
| Deployment | **No hosting is configured** (no CI or host settings in the repository) |

## Inputs I need (none is a secret except the first)
1. **Preflight access.** The preflight reads `PREFLIGHT_DB_URL` from the environment only. Never paste it into chat. Either:
   - *You run it* and send me the printed report (no secrets in it), or
   - *Launch Claude Code from a terminal where it is already set*, and I run the one read-only command. Same guarantees either way.
   ```powershell
   # PowerShell 5.1: type the string when prompted (not echoed, not stored in history)
   $s = Read-Host -AsSecureString 'Production DB connection string'
   $env:PREFLIGHT_DB_URL = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
   $env:PREFLIGHT_DB_SSL_CA = 'certs/supabase-ca-2021.crt'   # the Supabase root CA already in the repository
   node scripts/production/preflight.mjs
   ```
   It opens one `READ ONLY` transaction, verifies the server certificate, writes nothing, rolls back.
2. **Git remote and target.** The repository URL to push to, and whether to merge `security/anonymous-access` into `main` first (it holds all the work).
3. **Where the app is hosted** (e.g. Netlify, Vercel, Cloudflare Pages, your own server). The app is a static bundle (`npm run build` → `dist/`) that needs HTTPS for camera scanning. Build-time settings: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (public values).

## Sequence (each arrow is a gate)
1. **Preflight** (read-only) → I assess pending migrations, duplicates, hand-made objects, admins and authenticators. *Stop on any unresolved STOP.*
2. **Decisions** on real findings (duplicates, admins). → *Your approval.*
3. **Production backup** (restore point + encrypted logical copy / the app's Export backup) → *Your authorization; creates a file, changes no data.*
4. **Rehearsal on the restored backup** (`REHEARSAL_FILE`, `REHEARSAL_START`): whole pending chain, each migration's rows changed listed, last migration applied and rolled back exactly. *Stop on any difference.*
5. **Go / no-go** (list in the runbook) → my recommendation, *your decision.*
6. **Freeze, then migrations one at a time** with the Supabase CLI (pinned version, `db push --dry-run` first, row comparison after each) → *Your approval of the window; each migration is a production change.*
7. **Push the commit, then deploy the bundle built from that same commit** → *Your approval.*
8. **Admins enrol an authenticator, smoke checks, final comparison, end the freeze.**

## Rollback
Per migration, `supabase/rollback/<version>_down.sql` inside a transaction (each proved exact on a restored copy), or restore the restore point; redeploy the previous frontend. The freeze means nothing is lost between them.
