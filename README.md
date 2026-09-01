# Equipment Ledger

Internal equipment/accessory tracking for GroundGame Health — serialized asset lifecycle management (company laptops, and separately the Next Perimeter-supported "Active Laptops" fleet), Bulk Stock (accessories tracked by quantity), onboarding/offboarding workflows, mobile barcode/QR scanning, and Excel-based bulk import. Rebuilt from a single-file localStorage prototype onto Supabase (Postgres + Auth + Row-Level Security) with real, server-enforced role-based access control.

## Tech stack

- **Frontend**: React 19 + TypeScript + Vite, Tailwind CSS v4
- **Backend**: Supabase (Postgres, Auth, Row-Level Security). Lifecycle mutations go through `SECURITY DEFINER` Postgres functions (not raw table writes) so the status state machine, Swap's two-row transaction, and Bulk Stock's atomic bucket moves are enforced server-side, not just hidden in the UI.
- **PWA**: `vite-plugin-pwa` — installable, offline app-shell caching (ledger data itself is never cached; every read/write hits Supabase live)
- **Scanning**: `html5-qrcode` with `useBarCodeDetectorIfSupported: true` — prefers the browser's native `BarcodeDetector` API where available, falls back to the library's own JS decoder otherwise (this is what makes scanning work on iOS Safari)
- **Excel import**: SheetJS (`xlsx`), installed from SheetJS's own CDN rather than the npm registry — the npm package has an unpatched high-severity CVE; SheetJS ships fixes from their own site instead
- **Data fetching**: TanStack Query
- **Testing**: Vitest + React Testing Library

## Local setup

### Prerequisites

- Node.js 20+ and npm
- A [Supabase](https://supabase.com) account (free tier is fine)
- The Supabase CLI is used via `npx supabase ...` — no separate install needed

### 1. Install dependencies

```
npm install
```

### 2. Create a Supabase project

1. Create a new project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. Under **Settings → API**, copy the **Project URL** and the **`anon` `public`** key (or the newer `sb_publishable_...` key — either works).
3. Copy `.env.example` to `.env` and fill in both values:

   ```
   VITE_SUPABASE_URL=https://your-project-ref.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-or-publishable-key
   ```

   The anon key is safe to expose in the browser — **Row-Level Security policies are the real access-control gate**, not this key.

### 3. Push the database schema

All schema, RLS policies, and lifecycle functions live in `supabase/migrations/`, applied in order. Push them with the Supabase CLI:

```
npx supabase db push --db-url "<your-connection-string>"
```

Where to get the connection string: **Settings → Database → Connection string**. If your network only supports IPv4 (the direct `db.<ref>.supabase.co` hostname is IPv6-only on newer projects), use the **Session pooler** string instead (port 5432, username `postgres.<project-ref>`) — the **Transaction pooler** (port 6543) also works for most operations but isn't recommended for migrations. Remember to percent-encode any special characters in your database password (e.g. `@` → `%40`).

### 4. Bootstrap the first admin

New signups default to the `viewer` role (least privilege). To get your first admin:

1. In the Supabase dashboard: **Authentication → Users → Add user**, set an email/password, and check **Auto Confirm User**.
2. Promote them to admin with one SQL statement (via the SQL Editor in the dashboard, or `npx supabase db query --db-url "<connection-string>" "update profiles set role = 'admin' where email = 'you@example.com';"`).

After that, every other user's role can be managed from the in-app **Admin** panel — see [Adding more users](#adding-more-users) below.

### 5. Run it

```
npm run dev
```

Vite will print the local URL (defaults to `http://localhost:5173`, but picks the next free port if that's taken — check the terminal output).

## Adding more users

The client SDK can't create *other* users' logins directly — that requires the Supabase service-role key, which must never reach the browser. So user management is split:

- **Creating a login**: Supabase dashboard → **Authentication → Users → Add user** (check **Auto Confirm User**). They'll default to the `viewer` role.
- **Setting their role, or removing access**: the in-app **Admin** panel (Admin role only). "Remove access" deletes their `profiles` row rather than their auth account — every table's RLS policy requires a profile to exist, so this fully cuts off data access even though the login technically still exists in Supabase Auth.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Type-check (`tsc -b`) then produce a production build in `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run test:ui` | Run Vitest with its browser UI |
| `npm run lint` | Run oxlint |

## Testing strategy

- **State machine, Swap, Bulk Stock bucket rules**: pure TypeScript mirrors of the SQL logic (`src/lib/lifecycle.ts`, `src/lib/bulkLifecycle.ts`) are unit-tested exhaustively — every status/action pair from the spec's allowed-actions table is asserted, both positive and negative. These mirrors drive which buttons the UI shows; the SQL functions (`perform_lifecycle_action`, `perform_swap`, `perform_bulk_action`) are the actual server-side gate and are kept in sync via comments cross-referencing each other.
- **Import validation**: `src/lib/importValidation.ts` (required fields, in-sheet duplicate-serial detection, status/quantity validation) is unit-tested the same way.
- **Lifecycle UI**: `src/features/assets/ActionPanel.test.tsx` uses React Testing Library to verify role-gating and the confirm-form behavior (e.g. an assignee is required before Provide can be confirmed) without touching a real backend — Supabase calls are mocked at the module boundary.
- **The actual Postgres functions** (not just their TS mirrors) were verified by directly simulating real RPC calls against the live hosted database during development — creating a test asset, running it through Provide → Swap, checking the resulting rows and history, then cleaning up. This project's dev environment didn't have Docker available, so a local Supabase stack (`supabase start`) and a proper pgTAP suite weren't an option; if Docker becomes available, adding pgTAP tests under `supabase/tests/` for the SQL functions directly would be the natural next step.

## Architecture notes / documented assumptions

A few permission-boundary and design decisions were made explicitly rather than left implicit — noted here (and in code comments near where they're enforced) so they're easy to find and adjust:

- **`decommissioned` is not terminal.** It means the employee who had the device left the company; the device is refreshed and re-enters the reissue pool (Provide/Retain/Mark damaged all resume from there). **`nonfunctional`** is the actual terminal state.
- **Editor can Decommission** — treated as a routine offboarding step, not Admin-only. (`supabase/migrations/20260901000007_rls_policies.sql`)
- **Scanner role is narrower than Editor.** Scanner can look up any asset and use the scan-to-add flow (creating a new asset when a scanned serial isn't found), but lifecycle actions are limited to Provide/Collect only — enforced inside `perform_lifecycle_action`, not just hidden in the UI.
- **History tables are immutable** — no UPDATE/DELETE policy at all. Every write goes through `SECURITY DEFINER` functions that also write the history row in the same transaction.
- **Bulk Stock import rows add to `available`** rather than overwriting bucket state — a stock-count sheet doesn't know what's currently provided/retained/damaged/decommissioned, so overwriting would silently lose that.
- **Imports set status directly** rather than replaying rows through the interactive state machine — a bulk load is "this is the current/historical truth," and requiring every imported row to legally transition through intermediate statuses would make many legitimate historical imports impossible.
- **Onboarding's "Equipment assigned" step flips automatically** when a device is successfully assigned via the serial-entry flow, rather than being a separate manual checkbox.
- **Offboarding's checklist doesn't auto-trigger Collect/Decommission** on the employee's asset — it's an independent paperwork tracker; the actual lifecycle action happens on the asset's own detail page.
- Three collections (Serialized Assets, Active Laptops NP, Bulk Stock) are **deliberately separate tables**, not a single table with a type column — this mirrors the prototype's data model and the fact that Active Laptops NP represents a distinct vendor support relationship.

## Known limitations

- **Camera scanning requires HTTPS** (or `localhost`) — browsers won't grant camera access over plain HTTP on any other host. Testing the scan flow on a phone during local development needs an HTTPS tunnel (e.g. `npx localtunnel --port <dev-server-port>`, run in your own terminal so it stays alive) until this is deployed somewhere with real HTTPS.
- **`src/types/database.types.ts` is hand-written**, matching the migrations exactly, rather than generated via `npx supabase gen types typescript` — that codegen path needs a local Docker container, which wasn't available while building this. If Docker becomes available:
  ```
  npx supabase gen types typescript --db-url "<connection-string>" > src/types/database.types.ts
  ```
  then diff against the current file before replacing it (there's a specific TypeScript compatibility note at the top of that file worth preserving — using a named `interface` instead of an inline object literal for a table's `Row` type silently breaks `.rpc()` argument typing under the TypeScript version this project uses).
