# Equipment Ledger — Staging Setup and Security Test Guide

This guide walks you through creating a **separate, throwaway copy** of Equipment Ledger's backend (a "staging" Supabase project), filling it with **made-up data**, and testing the security fixes (migrations 022 and 023) against **real Supabase Auth, RLS and the REST API** — without touching production.

You don't need to be an experienced developer. Every command is copy-paste, and every step says what you should see. If anything looks different, **stop and send the output** (see [Step 14](#step-14--send-the-results-for-review)).

---

## Safety rules (read first)

1. **Production is never changed by anything in this guide.** The only thing that touches production is one optional *read-only* query in Step 5 and Step 13, which you run yourself.
2. **The staging scripts refuse to run against production.** They compare every setting in your staging file with the production project in `.env` and stop with `Refusing to run` if anything matches. There is no override.
3. **No real employee data goes into staging.** Staging gets synthetic data only — every serial starts with `SYN-` or `STG-`, every person is "Test Employee NN".
4. **Secrets stay on your computer.** Your staging passwords and keys go in `.env.staging.local`, which git ignores. Never paste its contents into chat, email or a ticket.
5. **The service_role key is never needed.** Don't copy it anywhere.

---

## What you'll end up with

| Thing | Where |
|---|---|
| A staging Supabase project | supabase.com dashboard, named `equipment-ledger-staging` |
| Your staging settings (secret) | `.env.staging.local` in the project folder (git-ignored) |
| Test results | Printed in the terminal, and saved in `.staging-state/` (git-ignored) |

Rough time: **45–60 minutes**, most of it waiting for Supabase to create the project.

---

## Step 1 — Prepare your computer

You need **Node.js 20 or newer**. Check in a terminal (PowerShell on Windows):

```
node --version
```

You should see `v20.x.x` or higher. If not, install the LTS version from [nodejs.org](https://nodejs.org).

Then, in the project folder:

```
git status
git switch security/anonymous-access
npm install
```

- `git status` should say `nothing to commit, working tree clean`. If it doesn't, stop and ask before continuing.
- `git switch` should say `Switched to branch 'security/anonymous-access'` (or `Already on …`).
- `npm install` should finish without `ERR!` lines (warnings are fine).

---

## Step 2 — Create the staging Supabase project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) and sign in.
2. Click **New project**.
3. Fill in:
   - **Organization:** the same one as production is fine.
   - **Project name:** `equipment-ledger-staging` — the word *staging* matters; it's how you'll tell the two apart at a glance.
   - **Database password:** click **Generate a password**, then **copy it into your password manager right now**. You'll need it in Step 4 and Supabase won't show it again.
   - **Region:** the same region as production.
   - **Plan:** Free is enough.
4. Click **Create new project** and wait until the dashboard stops saying *Setting up project* (a few minutes).

> **How to always know which project you're in:** the project name is shown at the top-left of the dashboard. Before running *any* SQL in this guide, check it says `equipment-ledger-staging` — except the two read-only queries in Steps 5 and 13, which are labeled **PRODUCTION (read-only)**.

---

## Step 3 — Staging authentication settings

In the **staging** project:

1. **Authentication → Sign In / Providers**
   - **Email**: enabled.
   - **Allow new users to sign up**: **OFF**.
   - **Allow anonymous sign-ins**: **ON** — *temporarily*. The tests need it on to prove that even a working anonymous session gets no data. You'll turn it off in Step 11.
   - Save.
2. **Authentication → URL Configuration**
   - **Site URL:** `http://localhost:5180` (the staging app's own address — see Step 12)
   - Save.

---

## Step 4 — Create your staging settings file (`.env.staging.local`)

1. In the project folder, make a copy of the template:
   ```
   copy .env.staging.example .env.staging.local
   ```
   (macOS/Linux: `cp .env.staging.example .env.staging.local`)
2. Open `.env.staging.local` in a text editor and replace each placeholder:

| Setting | Where to find it (in the **staging** project) |
|---|---|
| `VITE_STAGING_SUPABASE_URL` | **Project Settings → API → Project URL** (looks like `https://abcd….supabase.co`) |
| `VITE_STAGING_SUPABASE_ANON_KEY` | **Project Settings → API → Project API keys → `anon` `public`** (or the `sb_publishable_…` key). **Not** `service_role`. |
| `STAGING_DB_URL` | Click **Connect** (top bar) → **Session pooler** → copy the **URI**. Replace `[YOUR-PASSWORD]` with the password from Step 2. |
| `STAGING_DB_SSL_CA` | Optional but recommended: first create the folder with `mkdir .staging-state`, then **Project Settings → Database → SSL Configuration → Download certificate**. Save the file as `.staging-state/staging-ca.crt` inside the project folder, then set `STAGING_DB_SSL_CA=.staging-state/staging-ca.crt`. |
| `STAGING_ADMIN_EMAIL` / `PASSWORD` | Choose them now; you'll create this account in Step 6. Use a password you don't use anywhere else. |
| `STAGING_EDITOR_EMAIL` / `PASSWORD` | Optional second account to test the editor role. Leave blank to skip. |

**Password with special characters?** In `STAGING_DB_URL` only, replace them: `@` → `%40`, `#` → `%23`, `/` → `%2F`, `:` → `%3A`, `?` → `%3F`.

**Use the Session pooler, port 5432** — not "Direct connection" (it often doesn't work on home networks) and not the Transaction pooler (port 6543).

3. Confirm git will never pick the file up:
   ```
   git status
   ```
   You should **not** see `.env.staging.local` listed. (If you do, stop — don't commit anything — and ask.)

4. Check the scripts accept it (this only *reads* the settings and lists the plan; it changes nothing):
   ```
   npm run staging:migrate -- --dry-run
   ```
   You should see:
   ```
   Staging project: <staging-ref>   (production <prod-ref> is blocked)
   0 migration(s) already applied. To apply now:
     20260901000001_extensions_and_enums.sql
     …
     20260901000017_anonymous_public_demo.sql   [after: 017_after_role_cast.sql]
     …
     20260901000021_inventory_active_laptop_moves.sql   [before: 021_before_drop_changed_functions.sql]
     20260901000022_close_anonymous_access.sql
     20260901000023_remove_raw_ledger_writes.sql
   ```
   If you see `Refusing to run`, a value in your file belongs to production — fix it before going on.

---

## Step 5 — Build the staging database (up to migration 021) and compare it with production

### 5a. Apply migrations 001–021

```
npm run staging:migrate -- --until 20260901000021
```

You should see 21 lines starting with `✔` and then `Done. Applied 21 migration(s).`

Each migration runs in its own transaction: if one fails, nothing from it is applied and the script stops and tells you which one. Two migrations in the repository are known to fail as written, so the script applies a small, documented workaround for each (the files are in `supabase/adaptations/`):

| Migration | Problem as written | Workaround applied on staging |
|---|---|---|
| **017** anonymous demo | Its trigger produces `text` where the `user_role` type is required, so **creating any user fails** (`column "role" is of type user_role but expression is of type text`). | Re-creates the same function with the missing `::user_role` cast. |
| **021** inventory moves | Changes two functions' return types with `CREATE OR REPLACE`, which Postgres refuses (`cannot change return type of existing function`). | Drops those two functions first, in the same transaction, so 021 can create its versions. |

### 5b. Compare staging with production (recommended)

Production might differ from the repository files — for example its `handle_new_user` may have been fixed by hand, or 021 might never have been applied there. This comparison shows exactly how, **using definitions only — no table contents, no employee data**.

1. **PRODUCTION (read-only):** open the production project → **SQL Editor** → **New query**. Paste the whole of `supabase/staging/schema-fingerprint.sql` and click **Run**. The first line makes the session read-only, so it cannot change anything.
2. Under the results click **Export → Download CSV**. Save it as `.staging-state/prod-fingerprint.csv` in the project folder.
3. **STAGING:** do the same in the staging project. Save as `.staging-state/staging-fingerprint.csv`.
4. Compare:
   ```
   npm run staging:compare -- .staging-state/prod-fingerprint.csv .staging-state/staging-fingerprint.csv
   ```

**How to read the result:**

- `✔ Staging matches production exactly.` — continue.
- Differences in **`function handle_new_user`** only — expected (the 017 workaround vs. whatever production runs). Continue, and include the output when you send results.
- `moved_from_inventory`, or `perform_lifecycle_action … -> asset_collection`, **only in STAGING** — production does **not** have migration 021. Continue with testing, but tell me: it changes the production plan.
- Anything else — **stop** and send me the comparison output (it contains only object names and fingerprints).

---

## Step 6 — Create the staging test accounts

These accounts exist only in the staging project's own login system — completely separate from production. You can use your normal email address if you like, but **use a different password** from production.

1. **Staging** → **Authentication → Users → Add user → Create new user**
   - Email: your `STAGING_ADMIN_EMAIL`
   - Password: your `STAGING_ADMIN_PASSWORD`
   - Tick **Auto Confirm User**
   - **Create user**
2. (Optional) repeat for `STAGING_EDITOR_EMAIL`.
3. Give the accounts their roles (this talks only to staging):
   ```
   npm run staging:set-role
   npm run staging:set-role -- your-staging-editor@example.com editor
   ```
   The first command makes `STAGING_ADMIN_EMAIL` an admin. Each prints the staging account list — you should see your admin as `admin` (and the editor as `editor`).

   (Equivalent by hand: **staging** SQL Editor → `update profiles set role = 'admin' where email = '…';`)

If **Create user** fails with *Database error creating new user*, Step 5a didn't apply the 017 workaround — stop and send the Step 5a output.

---

## Step 7 — Fill staging with synthetic data

```
npm run staging:seed
```

You should see:

```
✔ Synthetic staging data created:
  inventory laptops: 25
  NP laptops: 12
  monitors: 15
  other equipment: 8
  bulk items: 5
  imports: 1
  onboarding checklists: 3
  offboarding checklists: 2
  duplicate patterns (3): 1
```

Everything goes through the app's own functions, signed in as your staging admin, in a single transaction. The three "duplicate patterns" are deliberate (the same serial in two collections; two serials differing only by upper/lower case; one with a leading space) — they're there for the duplicate investigation that comes later.

Running it again is safe: it says `Synthetic data is already present` and changes nothing.

---

## Step 8 — Before the fix: confirm the problem is real on staging

```
npm run staging:smoke -- pre
```

This signs in anonymously exactly like the old app did. Expect a table like:

| STATUS | CHECK |
|---|---|
| PASS | anonymous sign-in works (demo mode) |
| **EXPECTED** | anonymous user got the editor role (the vulnerability) |
| **EXPECTED** | anonymous session can read Laptop Inventory (the vulnerability) |
| PASS | saved this anonymous session to reuse after 022 |
| PASS | staging admin can sign in |

`EXPECTED` means "the security hole is present, as it is before the fix". The saved anonymous session (in `.staging-state/legacy-anon-session.json`) plays the part of a **real visitor who already had an anonymous session in production** — Step 10 checks it loses all access.

---

## Step 9 — Apply migrations 022 and 023 to staging

```
npm run staging:migrate
```

You should see:

```
21 migration(s) already applied. To apply now:
  20260901000022_close_anonymous_access.sql
  20260901000023_remove_raw_ledger_writes.sql
✔ 20260901000022_close_anonymous_access.sql
✔ 20260901000023_remove_raw_ledger_writes.sql
Done. Applied 2 migration(s).
```

---

## Step 10 — After the fix: test everything

### 10a. End-to-end test through real Supabase Auth and the REST API

```
npm run staging:smoke -- post
```

This takes a minute or two and runs roughly 150–170 checks. What each part proves:

| Area | What it checks |
|---|---|
| **legacy anonymous** | The session saved in Step 8 still *logs in* (expected — sessions aren't deleted) but: reads **0 rows** from all 14 tables and 5 dashboard views; **every** write function is rejected; every direct insert, update and delete is refused. |
| **new anonymous** | The same, for a brand-new anonymous session (anonymous sign-ins are still on). Also confirms it gets no profile. |
| **admin** | Sign in; create assets in all four collections; Provide (moves to Active Laptops), Transfer, Collect (moves back, full history kept); Mark damaged/repaired; Monitors and Other Equipment; **Swap**; **asset and bulk imports** and the import log; bulk stock; **onboarding** (create, tick a step, assign a device); **offboarding** (create, tick a step, find the employee's devices); **backup export** of every table with a completeness check; direct table writes blocked (023); can't raise an anonymous user's role; no anonymous probe write landed anywhere. |
| **editor** | (If configured) can use the app's actions; can't write to tables directly. |

**What a good result looks like:** every line is `PASS`, except:

- `KNOWN  C2: collecting an onboarding-assigned Inventory laptop fails (not fixed yet)` — expected; see [Step 13](#step-13--investigating-the-021-and-onboarding-foreign-key-problems).
- `INFO  anonymous sign-ins are still ENABLED on staging` — expected until Step 11.
- `INFO` lines that just report where files were saved.

The last lines show a tally (for example `PASS: …   KNOWN: 1   INFO: 3`) and where the full report was saved. **Any `FAIL` means stop** — send the report.

> Note: this test adds a few extra `STG-…` records to staging each time it runs. That's fine — staging is disposable and 023 means even the admin can no longer delete rows through the app.

### 10b. Database-level tests on staging

```
npm run staging:test-db
```

Expect: `Tests  25 passed | 13 skipped (38)`.

These run directly against the staging database — every test inside a transaction that is **rolled back**, so nothing on staging changes. The 13 skipped tests are the ones that rebuild a database from scratch; they only run on the disposable local database (`npm run test:db`).

---

## Step 11 — Turn anonymous sign-ins off on staging (the intended production setting)

1. **Staging → Authentication → Sign In / Providers → Allow anonymous sign-ins: OFF** → Save.
2. Run the end-to-end test again:
   ```
   npm run staging:smoke -- post
   ```
   The *new anonymous* section should now be a single line:
   `PASS  new anonymous  anonymous sign-ins are disabled on staging`
   The *legacy anonymous* section still runs (an existing session can still refresh) and must still be all `PASS` — no access.

---

## Step 12 — Click through the real app against staging

The full step-by-step manual test plan — every section, with expected results — is in **[STAGING_APP_TESTING.md](STAGING_APP_TESTING.md)**. The short version below is a quick health check.

```
npm run dev:staging
```

Open **http://localhost:5180**. A yellow **STAGING** bar across the top confirms you are on staging; the dev server refuses to start at all if `.env.staging.local` is missing or points at production.

1. **Private/incognito window first:** you should land on the **login page** and see no data. (Before this branch, visitors were let straight in.)
2. Sign in with your **staging admin**. Then check each item:

- [ ] Dashboard shows counts for all five sections.
- [ ] **Laptop Inventory** → open a laptop → **Provide** to "Test Employee 99" → you're taken to **Active Laptops (NP)**; history shows *created* and *provide*.
- [ ] Same laptop → **Collect** → back in **Laptop Inventory**, status *Available*.
- [ ] **Active Laptops (NP)** → a laptop with status *Active* → **Swap** with an available laptop, reason "test".
- [ ] **Monitors** → **Add asset**, then **Provide** and **Collect** it.
- [ ] **Bulk Stock** → an item → **Issue** 2.
- [ ] **Import from Excel** (from Monitors): a small `.xlsx` with columns *Name, Category, Serial* and 2 rows (serials starting `STG-`) → map → preview → commit → appears in **Import History**.
- [ ] **Onboarding** → new checklist "Test Employee 98" → tick *Identity created* → assign serial `SYN-INV-020`.
- [ ] **Offboarding** → new checklist for "Test Employee 01" → their devices are listed.
- [ ] **Data → Export backup** downloads a `.json` file.
- [ ] (Optional, staging only) **Data → Import backup** with that file, type `RESTORE` → succeeds, data unchanged.
- [ ] **Access & Roles** lists your staging accounts.

Stop the app with `Ctrl+C` in the terminal.

---

## Step 13 — Investigating the 021 and onboarding foreign-key problems

Nothing here changes production. These are the known problems, what staging showed, and **read-only** queries to measure their impact in production.

### Problem C3 — migration 021 can't be applied as written

- **What:** 021 uses `CREATE OR REPLACE` to change the return type of `perform_lifecycle_action` and `perform_swap`. Postgres refuses, and the whole migration rolls back.
- **Shown by:** `npm run test:db` (test *"C3: migration 021 as written fails"*) and Step 5a's need for the workaround.
- **Is 021 in production?** Step 5b answers it. Or run this in **PRODUCTION (read-only)**:
  ```sql
  set session characteristics as transaction read only;
  select
    exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'active_laptops_np'
              and column_name = 'moved_from_inventory') as has_021_column,
    pg_get_function_result('public.perform_lifecycle_action(asset_collection,uuid,asset_action,text,text)'::regprocedure) as lifecycle_returns;
  ```
  `true` / `asset_collection` → 021 is live in production. `false` / `void` → it isn't.
- **Possible fixes (not done yet — for a later approval):**
  - If 021 is **not** in production: correct the 021 file itself to drop the two functions first (nothing has applied it, so editing it is safe).
  - If 021 **is** in production: leave the file as history and keep the documented workaround for rebuilds.

### Problem C2 — a laptop assigned during onboarding can't be collected

- **What:** onboarding stores the laptop's id in `onboarding_checklists.assigned_asset_id`, which must point at a row in Active Laptops (NP). When an *Inventory* laptop is collected, migration 021 moves it back by deleting it from Active Laptops — which that link forbids, so **Collect, Decommission and Swap-out all fail** for that laptop.
- **Shown by:** Step 10a line `KNOWN C2 …`, and `npm run test:db` (*"KNOWN PRE-EXISTING BUG C2"*).
- **How many production laptops are affected?** **PRODUCTION (read-only)**, only if 021 is live:
  ```sql
  set session characteristics as transaction read only;
  select count(*) as laptops_that_cannot_be_collected
  from onboarding_checklists o
  join active_laptops_np a on a.id = o.assigned_asset_id
  where a.moved_from_inventory;
  ```
- **Possible fixes (not done yet — for a later approval):**
  - **A (recommended interim):** remove that one foreign-key link and keep the column. A laptop keeps the same id when it moves, so the onboarding record still identifies it correctly.
  - **B:** make the link `ON DELETE SET NULL` — simple, but the onboarding record then forgets which laptop it was.
  - **C (long-term):** the unified assets table, where laptops never move between tables, so the link can be a normal one again.

---

## Step 14 — Send the results for review

Send me (none of these contain secrets or real personal data):

1. The **terminal output** of Steps 5a, 9, 10a, 10b and 11 (or the `smoke-*.json` reports from `.staging-state/`).
2. The **Step 5b comparison output**.
3. The **Step 13 query results** (true/false, a number).
4. The Step 12 checklist with anything that didn't work.

**Never send:** `.env.staging.local`, `.staging-state/legacy-anon-session.json`, or any password or key.

---

## Step 15 — Afterwards

- **Keep** the staging project; it's needed for every later stage (backups, imports, duplicates). Free projects pause after a week of inactivity — **Restore project** in the dashboard brings them back.
- When you're completely done with this round, delete `.staging-state/legacy-anon-session.json`.
- To start completely fresh: delete the staging project in **Project Settings → General → Delete project** (check the name says *staging*!), then begin again at Step 2.

---

## Automated staging checks — what may change data

| Kind | Commands | Rule |
|---|---|---|
| **Read-only validation** (real Auth + REST API) | `npm run staging:verify`, `npm run staging:smoke -- post` | Never write. They check invariants that must hold for *whatever* records exist, never assume seed values, and probe write paths only with arguments that cannot succeed. |
| **Mutation tests** (direct database) | `npm run staging:test-db` | Create their **own** uniquely named records (`ZZ-…`) inside a transaction that is **always rolled back** — nothing they do is kept, even if a test fails. Existing (possibly hand-edited) records are never used as fixtures. |
| **Snapshots** (read-only) | `npm run staging:snapshot -- save <label>` / `compare <label>` | Full data backup + per-table fingerprints; `compare` proves whether anything changed. Run `save` before and `compare` after any change you want to verify. |

`npm run staging:smoke -- pre` is the one exception: it is only for a database **before** migrations 022/023 and it creates an anonymous user. If a check ever can't clean up after itself safely, it must stop and report rather than "restore" an assumed state.

## Migrations 025 and 026 on staging (employee equipment register)

Applied to staging on 2026-10-15 after a verified snapshot (`staging-pre-025`); the snapshot comparison showed every pre-existing row and column unchanged. To repeat on a fresh staging project: `npm run staging:migrate` (it applies 025 then 026 after 024), then `npm run staging:test-db` and `npm run staging:verify`. Browser checks: [STAGING_APP_TESTING.md](STAGING_APP_TESTING.md) sections 11–12.

## Migration 027 on staging (inventory integrity)

Applied to staging on 2026-10-16 after a verified snapshot (`staging-pre-027`, also restored into a disposable database to prove it is recoverable); the comparison showed every pre-existing row and column unchanged, with only the new `serial_keys` table added. It adds one-device-per-serial checks (existing duplicates are kept and listed for review under Access & Roles), makes Excel imports unable to change status or assignment, and makes restore verify row counts. Rollback: `supabase/rollback/20260901000027_down.sql` (run before `20260901000026_down.sql`). After applying: `npm run staging:test-db` (includes the two-connection concurrency test) and `npm run staging:verify`; browser checks in [STAGING_APP_TESTING.md](STAGING_APP_TESTING.md) 9.3–9.17 and 13.1–13.6 — regenerate the Excel files first with `npm run staging:test-files`.

## Migration 028 on staging (Active Employees) — not applied yet

Prepared locally; **not applied to hosted staging** until approved. It adds the Active Employees directory on the existing `employees` records (HR fields, work email unique once normalized, employment status, `employee_history` audit trail), the onboarding/offboarding completion triggers, and the import/edit functions. Existing employees are not put in the directory (their status stays empty). Rollback: `supabase/rollback/20260901000028_down.sql` (run before `20260901000027_down.sql`; it saves the new fields and history to `private.*_backup_028` first). After applying: `npm run staging:test-db` (includes `directory-live`, rolled back) and `npm run staging:verify`.

## Migration 029 on staging (activation safeguards, Bulk Stock H4)

Applied to staging on 2026-10-20 after a verified snapshot (`staging-pre-029`, also restored into a disposable database); a pre-check found no Bulk Stock items sharing a normalised name + category, and the comparison afterwards showed every pre-existing row and column unchanged (new: `employees.status_decision_required`, `bulk_import_receipts`). Onboarding completion only activates an employee whose imported Employee Status is recognised as Active (or who has no imported status — a genuine new hire); anything else is flagged "Employment status needs a decision" on Active Employees. Bulk Stock imports become deliveries recorded by content, so the same file again adds nothing unless confirmed as a new delivery; one bulk item per name + category is enforced. Rollback: `supabase/rollback/20260901000029_down.sql` (run before `20260901000028_down.sql`). After applying: `npm run staging:test-db` (includes `safeguards-live`: the onboarding safeguard and the two-connection import lock, rolled back) and `npm run staging:verify`.

## Migration 030 on staging (access revocation, admin two-factor)

Applied to staging on 2026-10-20 after a verified snapshot (`staging-pre-030`, restored into a disposable database and rehearsed there with 030 applied); the comparison afterwards showed every pre-existing row and column unchanged (new: three `profiles` columns, `profile_access_history`). No account was revoked, restored or changed. Remove access now revokes instead of deleting: a revoked account reads nothing and can change nothing, even from a session it already had open, and its previous role is kept for Restore access. Admin powers (role changes, Remove/Restore access, restore backup) need a two-factor (aal2) session; the last active admin can't be demoted or revoked. **Until the staging admin enrols two-factor on the Security page, they can't change roles or access** (they still have editor-level access). Rollback: `supabase/rollback/20260901000030_down.sql` (refuses while any account is revoked; run before `20260901000029_down.sql`). After applying: `npm run staging:test-db` (includes `access-live`, rolled back, temporary users only) and `npm run staging:verify`.

## Production deployment checklist (for later — needs explicit approval at each step)

Do **not** start this until the staging results have been reviewed and approved.

- [ ] Staging Steps 5–12 all passed; results reviewed.
- [ ] Step 5b showed production's schema matches what was tested (or every difference is understood).
- [ ] **Your production admin login works:** private window → sign in → *Access & Roles* is visible. **If not, stop.**
- [ ] **Full backup of production** taken and its row counts checked (read-only `supabase db dump` of schema and data, plus the latest dashboard backup).
- [ ] **Production → Authentication → Sign In / Providers:** *Allow anonymous sign-ins* **OFF**, *Allow new users to sign up* **OFF**.
- [ ] **Apply 022 in the production SQL Editor** inside `begin; … commit;` — **not** `supabase db push`, which could also try to push 015–021. Before `commit;` check: your admin is still `admin`, `private.anonymous_role_backup_022` has the expected rows, every anonymous profile is `viewer`.
- [ ] Re-sign in as admin; do one lifecycle action, one import preview, one backup export.
- [ ] Deploy the frontend from this branch (removes the automatic anonymous sign-in).
- [ ] Private window → login page, no data.
- [ ] After 022 has been stable for a day or so: apply 023 the same way, then repeat the admin checks.
- [ ] **If anything goes wrong:** run `supabase/rollback/20260901000023_down.sql` and/or `…22_down.sql` in a transaction (keep anonymous sign-ins **off** while rolled back).

---

## Remaining risks to keep in mind

- **Existing anonymous sessions** still *authenticate* after 022 — they just get no data and can't change anything. If you want them fully cut off, the supported route is banning those users through the Supabase Admin API (tested on staging first). Rows in `auth.sessions` are not deleted by hand.
- **Real viewer accounts can read everything** — by design. With sign-ups off, only accounts you create can exist.
- **Not fixed yet:** C3 (021 file), the admin "Remove access" button failing for users who have history, editors being able to write fake import-log rows, and MFA for the admin account. (C2 the onboarding laptop link is fixed by migration 026; C4 imports, C5 the backup 1,000-row limit, and M1 duplicate serials are fixed by migration 027 and the matching app changes — see "Migration 027 on staging" above.)
- **Staging is not production:** Step 5b is what tells you how closely they match.

---

## Troubleshooting

| You see | What it means / what to do |
|---|---|
| `Refusing to run` | A value in `.env.staging.local` belongs to production (or doesn't match the staging project). Re-copy it from the **staging** dashboard. |
| `… is missing or still a placeholder` | A line in `.env.staging.local` still has `your-…` in it. |
| `password authentication failed` | Wrong database password in `STAGING_DB_URL`, or a special character not percent-encoded (Step 4). Reset it in **Project Settings → Database** if needed. |
| `Tenant or user not found` | The username in `STAGING_DB_URL` must be `postgres.<staging-ref>` (Session pooler format). |
| `ENOTFOUND` / `ETIMEDOUT` | You copied the *Direct connection* string; use **Session pooler** (Step 4). |
| `self-signed certificate in certificate chain` | Set `STAGING_DB_SSL_CA` to the downloaded certificate (Step 4). |
| `not a fresh staging project` | The database already has app tables that the script didn't create. Use a new, empty staging project. |
| `No staging user with email …` / `is not an admin` | Do Step 6, then re-run. |
| `Database error creating new user` (dashboard) | The 017 workaround is missing — re-run Step 5a and send its output. |
| `anonymous sign-in (must be ENABLED …)` in Step 8 | Turn **Allow anonymous sign-ins** on (Step 3). |
| `saved pre-022 session exists … FAIL` in Step 10 | Step 8 wasn't run before Step 9. Results for the "legacy" section are missing; everything else still counts. |
| Anything else | Stop and send the full terminal output. |
