# Equipment Ledger — Manual Test Plan (Staging)

Use this to test the **whole application in your browser, as the administrator**, against the staging project — before approving any production change. Everything here uses **synthetic data only** and **never touches production**.

**Before you start:** finish [STAGING_SETUP.md](STAGING_SETUP.md) Steps 1–11 (staging project, settings file, migrations 001–023, accounts, synthetic data, anonymous sign-ins turned off).

How to use this document:
- Work top to bottom. Each test says **Do** and **Expect**.
- Tick ☐ → ☑ as you go, and note anything that differs.
- Items marked **⚠ KNOWN BUG** are problems found in the audit that are **not fixed yet**. They're included so you can see them for yourself — the "Expect" describes the *current, wrong* behaviour. Reset staging afterwards ([section R](#r--resetting-staging-between-test-rounds)).
- If something fails that is *not* marked as a known bug, note the section number, what you did, and what you saw.

---

## 0. Start the staging app

In a terminal, in the project folder:

```
git switch security/anonymous-access
npm run staging:reset
npm run staging:test-files
npm run dev:staging
```

| Command | What it does |
|---|---|
| `staging:reset` | Asks you to type the staging project ref, then wipes staging's equipment data and re-creates the standard synthetic data set, so you start from a known state. Your accounts are kept. |
| `staging:test-files` | Creates the sample Excel files and printable scan labels used below, in `.staging-state/test-files/` (git-ignored). |
| `dev:staging` | Starts the app connected **only** to staging, at **http://localhost:5180**. Leave this terminal open; stop it with `Ctrl+C`. |

**Safety checks built in** — `dev:staging` will **refuse to start** if `.env.staging.local` is missing, still has placeholders, or points at the production project; the app itself refuses to connect for the same reasons; and staging builds can't be created at all, so a staging version can't be deployed by accident.

---

## 1. Safety and sign-in

| # | Do | Expect | ☐ |
|---|---|---|---|
| 1.1 | Open **http://localhost:5180** | A **yellow STAGING bar** at the top showing the staging project ref; browser tab title starts with **[STAGING]**. | ☐ |
| 1.2 | Open the same address in a **private/incognito window** | The **login page**; no equipment data visible. (Before the fix, visitors were let straight in.) | ☐ |
| 1.3 | Sign in with a wrong password | An error message; you stay on the login page. | ☐ |
| 1.4 | Sign in as your **staging admin** | The **Overview** page: "Welcome, …", "Signed in as **admin**". Sidebar shows Overview, Scan, Laptop Inventory, Onboarding, Offboarding, Monitors, Other Equipment, Bulk Stock, Access & Roles, Import History, Export backup, Import backup. | ☐ |
| 1.5 | Sidebar bottom → **Sign out**, then sign back in | Signed out to the login page; signing in works again. | ☐ |

---

## 2. Overview (dashboard)

Fresh synthetic data (right after `staging:reset`):

| Card | Expect |
|---|---|
| Laptop Inventory | **40 total** — Active / Assigned 13, Available 21, Damaged / Repair 3, Other 3; "14 NP-managed · 26 Company". Each tile opens that tab. |
| Monitors | **19 total** — Provided 6, Available 12, Damaged 1 |
| Other Equipment | **10 total** — Provided 2, Available 8 |
| Bulk Stock | **175 total units** — Available 129, Provided 46, others 0 |

☐ Counts match. Every laptop is counted once, whichever table it currently lives in.

---

## 3. Laptop Inventory (one list for every laptop)

Laptop Inventory now shows **every laptop** — company laptops and Next Perimeter-managed ones, assigned or not — in one table. Behind the scenes the two database tables are unchanged; each row still opens the laptop's own detail page.

| # | Do | Expect | ☐ |
|---|---|---|---|
| 3.1 | **Laptop Inventory** | Header "40 laptops in total · 14 NP-managed · 26 Company". Tabs: **All Laptops 40**, **Active / Assigned 13**, **Available 21**, **Damaged / Repair 3**, **Other 3**. | ☐ |
| 3.2 | Click each tab | Rows match the count; every row shows its **actual status** (e.g. Other shows Retained ×2 and Nonfunctional ×1). | ☐ |
| 3.3 | **Active / Assigned** | 13 laptops, all status **Provided** with an employee: `SYN-INV-001`…`005` (Company) and `SYN-NP-001`…`008` (NP-managed). `SYN-NP-009`…`012` are **not** here — they're NP laptops that are available. | ☐ |
| 3.4 | Scope **NP-managed**, then **Company** | NP-managed 14 (`SYN-NP-…` and both `SYN-DUP-C` records); Company 26. The tab counts update to match the scope. | ☐ |
| 3.5 | Search `employee 07`, then `dell, inc` | First: SYN-NP-002 only. Second: "No laptops match these filters" — no error (the old comma bug, M4, doesn't affect this page). | ☐ |
| 3.6 | Click column headers (Serial number, Assigned to, Status…) | Rows re-sort; clicking again reverses. | ☐ |
| 3.7 | Rows marked **⚠ Duplicate serial** | `SYN-DUP-C` and ` SYN-DUP-C` (same serial apart from a space) are both listed and both flagged — nothing is hidden. | ☐ |
| 3.8 | Open the old address **http://localhost:5180/active-laptops-np** | Redirects to Laptop Inventory with **Active / Assigned** selected. | ☐ |
| 3.9 | Click **SYN-INV-021** | Its detail page opens at the same address as before (`/serialized-assets/…`); **← Back** returns to Laptop Inventory. | ☐ |
| 3.10 | **Add laptop** → choose **Company**, Name `Dell Latitude 7450`, Category `Laptop`, Serial `SYN-INV-300` | Added; appears under Available, scope Company. Adding `SYN-INV-300` again fails (duplicate). | ☐ |
| 3.11 | **Add laptop** with Serial ` SYN-INV-300` (leading space) | **⚠ KNOWN BUG M1:** accepted as a different laptop, and both rows show **⚠ Duplicate serial**. | ☐ |

### Export to Excel

| # | Do | Expect | ☐ |
|---|---|---|---|
| 3.12 | Tab **Active / Assigned**, scope **NP-managed**, sort by Serial → **Export to Excel (8)** | Downloads `laptop-inventory-active-np-<date>.xlsx`. Sheet **Laptops** has exactly the 8 rows in the same order; sheet **Export details** lists the tab, scope, search and sort. | ☐ |
| 3.13 | In Excel, look at the Serial Number column | Text, not numbers; no IDs or database columns; Assigned To is the only employee information. | ☐ |
| 3.14 | Search `SYN-INV` on **All Laptops** → export | Only the matching rows — all of them, even when there are more than 50 (more than one page). | ☐ |

---

## 4. Lifecycle actions from Laptop Inventory

Each action is done on the laptop's detail page (click the row). Afterwards, go **← Back** — the laptop has moved to the right tab, and no second record appears.

| # | Do | Expect | ☐ |
|---|---|---|---|
| 4.1 | **SYN-INV-021** → **Provide** to `Test Employee 50` | Detail page shows it Provided to Test Employee 50 (its address changes to `/active-laptops-np/…`; same laptop). Back: it's in **Active / Assigned**, scope **Company**; total still 40. | ☐ |
| 4.2 | Same laptop → **Transfer** to `Test Employee 51` | Still Active / Assigned; Assigned to Test Employee 51. | ☐ |
| 4.3 | Same laptop → **Collect** | Back in **Available**, unassigned; history shows created, provide, transfer, collect. | ☐ |
| 4.4 | **Mark damaged**, then **Mark repaired** | Moves to **Damaged / Repair**, then back to **Available**. | ☐ |
| 4.5 | **SYN-INV-009** (Other, Nonfunctional) | No action buttons — it's the final state. | ☐ |
| 4.6 | **SYN-NP-010** (Available, NP-managed) → **Provide** to `Test Employee 53` → **Collect** | Active / Assigned → Available; scope stays **NP-managed** throughout. | ☐ |
| 4.7 | **SYN-INV-002** (Active, Test Employee 02) → **Decommission (employee left)** | Lands in **Other** as Decommissioned, unassigned, scope Company. | ☐ |
| 4.8 | **SYN-NP-004** (Active) → **Mark damaged** | **⚠ KNOWN BUG H6:** it moves to Damaged / Repair but **still shows Assigned to** the employee, and the row shows **⚠ Check assignment**. | ☐ |

---

## 5. Swap

| # | Do | Expect | ☐ |
|---|---|---|---|
| 5.1 | Laptop Inventory → **Active / Assigned** → open **SYN-NP-001** (Test Employee 06) → **Swap** | A Swap panel; the replacement list shows available/decommissioned laptops of both scopes. | ☐ |
| 5.2 | Click **Confirm swap** with nothing chosen | Button is disabled until a device and a reason are given. | ☐ |
| 5.3 | Choose **SYN-INV-015**, reason `cracked screen` → **Confirm swap** | SYN-NP-001 becomes **Damaged**, unassigned, with a *swap* history entry naming SYN-INV-015. | ☐ |
| 5.4 | Laptop Inventory → **SYN-INV-015** | Now in **Active / Assigned**, Assigned to **Test Employee 06**, history *swap* … "Replaces serial SYN-NP-001". SYN-NP-001 is in Damaged / Repair. | ☐ |

---

## 6. Monitors

| # | Do | Expect | ☐ |
|---|---|---|---|
| 6.1 | **Monitors** | 19 monitors, incl. `SYN-IMP-1…3` (from the synthetic import) and `SYN-DUP-A`. | ☐ |
| 6.2 | Open **SYN-MON-008** → **Provide** to `Test Employee 54` → then **Collect** | Status Provided → Available. **Stays in Monitors** both times. | ☐ |
| 6.3 | **SYN-MON-015** (Damaged) → **Mark non-functional** | Status Nonfunctional; no further actions. | ☐ |
| 6.4 | **SYN-MON-001** → **Swap** | Replacement list shows available monitors only. Pick **SYN-MON-009**, reason `flicker` → SYN-MON-009 is Provided to Test Employee 01. | ☐ |

---

## 7. Other Equipment

| # | Do | Expect | ☐ |
|---|---|---|---|
| 7.1 | **Other Equipment** | 10 items (docks and headsets), incl. `SYN-DUP-B` and `syn-dup-b`. | ☐ |
| 7.2 | `SYN-DUP-B` and `syn-dup-b` both listed | **⚠ KNOWN BUG (duplicates):** two records for what is probably one device — only upper/lower case differs. | ☐ |
| 7.3 | Open **SYN-OTH-004** → **Retain** → then **Provide** to `Test Employee 55` | Retained → Provided. Stays in Other Equipment. | ☐ |

---

## 8. Bulk Stock

| # | Do | Expect | ☐ |
|---|---|---|---|
| 8.1 | **Bulk Stock** | Wireless Mouse, USB-C Charger, Keyboard, HDMI Cable, Laptop Bag. | ☐ |
| 8.2 | Open **Wireless Mouse** | Available 28, Provided 12; history *created* + *issue*. | ☐ |
| 8.3 | **Issue** 3 → Confirm | Available 25, Provided 15. | ☐ |
| 8.4 | **Return** 2 | Available 27, Provided 13. | ☐ |
| 8.5 | **Mark damaged** 1, from **Available** | Available 26, Damaged 1. | ☐ |
| 8.6 | **Repair** 1 | Available 27, Damaged 0. | ☐ |
| 8.7 | **Issue** 999 | Error "Insufficient quantity in available (have 27, need 999)"; nothing changes. | ☐ |
| 8.8 | **Add item** → `Webcam`, `Accessory`, quantity 10 | New item with Available 10. | ☐ |

---

## 9. Excel import

Files are in `.staging-state/test-files/` (created by `npm run staging:test-files`). Each import: list page → **Import from Excel** → choose the file → map columns (Name→Name, Category→Category, Serial→Serial, etc.; leave unmapped columns as "— not mapped —") → **Preview** → read the preview → **Commit**.

| # | Do | Expect | ☐ |
|---|---|---|---|
| 9.1 | **Monitors** → import `01-monitors-new.xlsx` | Preview: **To create 4**, To update 0, Errors 0. Commit → "4 created, 0 updated". `SYN-MON-101…104` appear in Monitors. | ☐ |
| 9.2 | **Import History** | The import is listed with target Monitors, filename, 4 created. | ☐ |
| 9.3 | Import `01-monitors-new.xlsx` **again** | Preview: To update 4. Commit → "0 created, 4 updated" (no duplicates — matched by serial). | ☐ |
| 9.4 | **Laptop Inventory** → **Import from Excel** → **Serialized Assets** (= Company laptops) → import `02-inventory-with-errors.xlsx` (map Status too) | Preview: To create 1, **Errors (skipped) 3** — "Missing serial", "Invalid status "broken"", "Duplicate serial in this sheet". Commit → 1 created (`SYN-INV-201`). | ☐ |
| 9.5 | Check **Import History** for 9.4 | **⚠ KNOWN BUG M3:** shows **0 errored**, although 3 rows were skipped. | ☐ |
| 9.6 | Note SYN-NP-002 is Active / Test Employee 07 → **Import from Excel** → **Active Laptops (NP)** → import `03-KNOWN-BUG-np-status-reset.xlsx` | **⚠ KNOWN BUG C4 (the import-corruption bug):** preview says Update 3 with no warning; after commit SYN-NP-001…003 are **Available and unassigned** — their assignments were wiped because the sheet had no Status/Assigned-to columns. | ☐ |
| 9.7 | **Laptop Inventory** → import `04-KNOWN-BUG-case-mismatch.xlsx` | **⚠ KNOWN BUG H2:** preview says **Update** (it matched SYN-INV-012 ignoring case) but commit says **1 created** — a second laptop `syn-inv-012` now exists. | ☐ |
| 9.8 | **Laptop Inventory** → import `05-KNOWN-BUG-cross-collection.xlsx` (SYN-INV-001 is assigned to Test Employee 01, so it lives in Active Laptops) | **⚠ KNOWN BUG H3:** preview says **Create**; a second `SYN-INV-001` appears in Laptop Inventory while the real one is in Active Laptops. | ☐ |
| 9.9 | After 9.8: Laptop Inventory → the **SYN-INV-001** in Active / Assigned → **Collect** | Fails with a duplicate-key error — the duplicate from 9.8 blocks the move back. | ☐ |
| 9.10 | **Bulk Stock** → import `06-bulk-received.xlsx` (map Quantity) | Preview: Update 1 (Wireless Mouse), Create 1 (Webcam, unless added in 8.8). Commit → Wireless Mouse Available +10. | ☐ |
| 9.11 | Import `06-bulk-received.xlsx` **again** | **⚠ KNOWN BUG H4:** Wireless Mouse goes up by **another 10** — the same file counted twice. | ☐ |
| 9.12 | **Other Equipment** → import `07-KNOWN-BUG-header-space.xlsx` | **⚠ KNOWN BUG M5:** the column shows as "Serial" in the mapping, but the preview shows **Missing serial** on every row (the sheet's header is "Serial " with a trailing space). | ☐ |
| 9.13 | Upload any `.json` or `.txt` file | An error "Could not read that file" or "No data found"; nothing imported. | ☐ |

---

## 10. Scanning

The camera needs either this computer's webcam or manual entry. (Phones can't use the camera against `http://localhost`; phone testing is a separate step.)

**Manual entry** — **Scan** → "Or enter serial manually" → **Look up**:

| # | Serial | Expect | ☐ |
|---|---|---|---|
| 10.1 | `SYN-INV-022` | Opens that laptop in Laptop Inventory. | ☐ |
| 10.2 | `SYN-INV-003` | Opens its detail page (it was provided, so it now lives under `/active-laptops-np/…`). | ☐ |
| 10.3 | `SYN-MON-010` | Opens the monitor. | ☐ |
| 10.4 | `SYN-NEW-001` | "No asset found … What kind of equipment is this?" with four choices. Choose **Monitor** → the add form has the serial filled in → **Add asset** → opens the new monitor. | ☐ |
| 10.5 | `syn-inv-022` (lower case) | **⚠ KNOWN BUG M1:** "No asset found" — lookups are case-sensitive. | ☐ |
| 10.6 | `SYN-DUP-A` | **⚠ KNOWN BUG M2:** opens the Laptop Inventory record **without warning** that a Monitor has the same serial. | ☐ |

**Camera** — open `.staging-state/test-files/scan-labels.html` on a phone (e.g. email it to yourself — it's synthetic) or print it. On this computer: **Scan** → allow camera access → hold a label up to the webcam.

| # | Do | Expect | ☐ |
|---|---|---|---|
| 10.7 | Scan the **SYN-INV-021** label | Jumps straight to that laptop's page. | ☐ |
| 10.8 | Deny camera permission (browser address bar → camera → Block), reload Scan | A clear message about camera access; manual entry still works. | ☐ |

---

## 11. Onboarding

| # | Do | Expect | ☐ |
|---|---|---|---|
| 11.1 | **Onboarding** | Test Employee 30, 31, 32 (31 and 32 have *Identity created* ticked). | ☐ |
| 11.2 | **Start onboarding** → `Test Employee 60` → **Start** | Opens the checklist with four unticked steps; *Equipment assigned* says "(set automatically below)". | ☐ |
| 11.3 | Tick **Identity created**, reload the page | Still ticked. | ☐ |
| 11.4 | Assign equipment → Serial `SYN-INV-023` → **Assign device** | *Equipment assigned* ticks itself; "Assigned device" shows SYN-INV-023. In Laptop Inventory it's under **Active / Assigned**, Assigned to Test Employee 60, scope Company. | ☐ |
| 11.5 | New onboarding `Test Employee 61` → serial `SYN-NEW-500` | Asks for device name and category ("That serial isn't in Active Laptops (NP) yet…"). Enter `Lenovo ThinkPad T14` / `Laptop` → assigned; a new laptop SYN-NEW-500 appears in Laptop Inventory as Active / Assigned, scope NP-managed. | ☐ |
| 11.6 | New onboarding `Test Employee 62` → serial `SYN-INV-006` (Damaged) | Error "Device SYN-INV-006 is not available to assign (currently damaged)"; nothing changes. | ☐ |
| 11.7 | Laptop Inventory → **SYN-INV-023** (from 11.4) → **Collect** | **⚠ KNOWN BUG C2:** fails with a foreign-key error — a laptop assigned through onboarding can't be collected. | ☐ |
| 11.8 | Tick **Required access provided** and **Onboarding successful** for Test Employee 60 | Both save. | ☐ |

---

## 12. Offboarding

Offboarding is now **two required steps**: **Removed access** and **one laptop outcome** — Laptop received, Laptop retained, Laptop decommissioned, or **Not applicable** (no company laptop). The three laptop outcomes are alternatives: choosing one replaces the other. Choosing an outcome **never** collects or changes the laptop itself.

| # | Do | Expect | ☐ |
|---|---|---|---|
| 12.1 | **Offboarding** | A table like Onboarding's: Test Employee 01 and 02 at **0/2 Not Started**; **Test Employee 46 (legacy conflict)** at **1/2 Pending** with **⚠ Laptop outcome needs review**. Search, status filter and sorting work as on Onboarding. | ☐ |
| 12.2 | Open **Test Employee 46 (legacy conflict)** | A warning: "Needs review: this record had Laptop received, Laptop retained all ticked…". No outcome is pre-selected ("Not decided yet"). | ☐ |
| 12.3 | Choose **Laptop retained** | Saved; the warning disappears; "2/2 required steps done". Back on the list: **Completed**, no review flag. | ☐ |
| 12.4 | **Start offboarding** → `Test Employee 04` → **Start** | Removed access (tick box) + Laptop outcome (5 choices) and "Assets currently assigned to Test Employee 04" listing **SYN-INV-004**. 0/2. | ☐ |
| 12.5 | Tick **Removed access**, choose **Laptop received** | 2/2 → Completed. **SYN-INV-004 is still assigned** (status Provided) — recording the outcome doesn't collect it. | ☐ |
| 12.6 | Switch the outcome to **Laptop decommissioned**, then **Not decided yet** | Only one is ever selected; back to 1/2 Pending. | ☐ |
| 12.7 | **Start offboarding** → `Test Employee 98` (has no laptop) | The page says no laptop is assigned and suggests **Not applicable**. Choose it + tick Removed access → **Completed**. | ☐ |
| 12.8 | From 12.4's page, click **SYN-INV-004** → **Collect** | It returns to Available in Laptop Inventory and disappears from Test Employee 04's list. | ☐ |
| 12.9 | **⚠ KNOWN BUG H5** | Test Employee 04 also has monitor **SYN-MON-004**, but it isn't listed — offboarding only looks at laptops. | ☐ |

---

## 13. Backup and restore

Do these **after** a few changes above, so there is something to compare.

| # | Do | Expect | ☐ |
|---|---|---|---|
| 13.1 | **Export backup** → **Export backup** | Downloads `equipment-ledger-backup-<date>.json`. | ☐ |
| 13.2 | Make one visible change: Monitors → **SYN-MON-011** → **Retain** | Status Retained. | ☐ |
| 13.3 | **Import backup** → choose the file from 13.1 | A red warning, "About to restore … wiping all current data", and a box asking you to type **RESTORE**. The red button stays disabled until you do. | ☐ |
| 13.4 | Type `RESTORE` → **Restore and overwrite everything** | "Backup restored at …". **SYN-MON-011** is **Available** again; everything else matches the moment of export — including offboarding outcomes such as **Not applicable**. | ☐ |
| 13.5 | Choose a `.xlsx` or random `.json` file to restore | An error "does not look like an Equipment Ledger backup" (for a non-backup JSON), or a read error; nothing restored. | ☐ |

**⚠ KNOWN BUG C5 (optional, shows data loss):** run `npm run staging:reset -- --large` (adds 1,120 history rows), then **Export backup** → open the file in a text editor → `serialized_asset_history` holds only **1,000** entries, not 1,148. Restoring that file would permanently delete the rest. **Don't** restore it unless you want to see that; reset afterwards.

---

## 14. Access & Roles (admin)

| # | Do | Expect | ☐ |
|---|---|---|---|
| 14.1 | **Access & Roles** | Your staging accounts with their roles; yours marked "(you)". | ☐ |
| 14.2 | Change the editor account's role to **viewer** | Saves. | ☐ |
| 14.3 | **Remove access** on the editor account (it has history from the Step 10a smoke test) → **Confirm remove** | **⚠ KNOWN BUG:** fails, because history still references that account. (If it succeeds instead, that account had no history yet.) | ☐ |
| 14.4 | Either way, put the editor back: `npm run staging:set-role -- <editor email> editor` | Prints the editor as `editor` (this also restores the account if 14.3 removed it). | ☐ |

---

## 15. Other roles (optional)

Sign out, then sign in as the staging **editor** (and, if you create one, a **viewer**):

| # | As | Expect | ☐ |
|---|---|---|---|
| 15.1 | Editor | Same equipment pages and actions as admin; **no** Access & Roles, **no** Export/Import backup in the menu. Visiting `http://localhost:5180/data` shows "You don't have access to this page". | ☐ |
| 15.2 | Viewer | Can browse every list and detail page; **no action buttons**, no Add asset, no Import from Excel. | ☐ |

(Create a viewer: staging dashboard → Authentication → Users → Add user, then `npm run staging:set-role -- <email> viewer`.)

---

## 16. Password reset (optional)

Supabase's built-in email service on a new project only delivers to members of your Supabase organization, and only a few emails per hour. To test: **staging** → **Authentication → Emails → Reset password** → replace the message body with the contents of `supabase/templates/recovery.html` → Save. Then on the login page use **Forgot password?** with your staging admin email → enter the 6-digit code from the email → set a new password → you're signed in. Update `STAGING_ADMIN_PASSWORD` in `.env.staging.local` afterwards.

---

## R — Resetting staging between test rounds

```
npm run staging:reset
```

- Type the staging project ref when asked (shown at the top of the output; there's no way to skip this question).
- It deletes **all** equipment, history, checklists and import records **on staging only**, in one transaction, then re-creates the standard synthetic data. Accounts and their roles are kept.
- `npm run staging:reset -- --large` does the same plus 1,120 extra history rows (for the C5 test in section 13).
- If the app is open, **reload the page** afterwards.
- The scripts refuse to run against production.

---

## Recording results

For each section note: all passed / which numbers failed and what you saw. Known-bug items "pass" if the bug behaves as described. Send that list, plus anything else surprising. **Never send** `.env.staging.local` or any password.
