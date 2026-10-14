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
| 1.4 | Sign in as your **staging admin** | The **Overview** page: "Welcome, …", "Signed in as **admin**". Sidebar shows Overview, Scan, Laptop Inventory, Active Laptops (NP), Onboarding, Offboarding, Monitors, Other Equipment, Bulk Stock, Access & Roles, Import History, Export backup, Import backup. | ☐ |
| 1.5 | Sidebar bottom → **Sign out**, then sign back in | Signed out to the login page; signing in works again. | ☐ |

---

## 2. Overview (dashboard)

Fresh synthetic data (right after `staging:reset`):

| Card | Expect |
|---|---|
| Serialized Assets *(this is Laptop Inventory)* | **21 total** — Available 15, Damaged 3, Retained 2, Nonfunctional 1 |
| Active Laptops (NP) | **19 total** — Active 13, Available 6 |
| Monitors | **19 total** — Provided 6, Available 12, Damaged 1 |
| Other Equipment | **10 total** — Provided 2, Available 8 |
| Bulk Stock | **175 total units** — Available 129, Provided 46, others 0 |

☐ Counts match. (The card says "Serialized Assets" while the menu says "Laptop Inventory" — a naming inconsistency noted in the audit, L5.)

---

## 3. Laptop Inventory

| # | Do | Expect | ☐ |
|---|---|---|---|
| 3.1 | **Laptop Inventory** | 21 laptops; serials `SYN-INV-006` … `SYN-INV-025` plus `SYN-DUP-A`. (`SYN-INV-001`–`005` are not here — they are assigned, so they live in Active Laptops.) | ☐ |
| 3.2 | Search `INV-02` | Only serials containing INV-02 remain. Clear the search. | ☐ |
| 3.3 | Search `Dell, Inc` | **⚠ KNOWN BUG M4:** an error message (or odd results) instead of a normal search — a comma breaks the search filter. | ☐ |
| 3.4 | Open **SYN-INV-021** | Detail page: status Available, Category Laptop, Location Tampa Office, history with one *created* entry. Buttons: **Provide, Retain, Mark damaged**. | ☐ |
| 3.5 | **Provide** → Assigned to `Test Employee 50` → **Confirm** | You're taken to the **Active Laptops (NP)** page for the same laptop; status **Active**, Assigned to Test Employee 50; history now *provide* + *created*. | ☐ |
| 3.6 | **Transfer** → `Test Employee 51` → Confirm | Stays in Active Laptops; Assigned to Test Employee 51; history adds *transfer*. | ☐ |
| 3.7 | **Collect** → Confirm | Taken back to **Laptop Inventory**; status Available, Assigned to —; history shows all four entries. | ☐ |
| 3.8 | **Mark damaged** → Confirm | Status Damaged; buttons now **Mark repaired, Mark non-functional**. | ☐ |
| 3.9 | **Mark repaired** → Confirm | Status Available. | ☐ |
| 3.10 | Open **SYN-INV-009** | Status Nonfunctional; **no action buttons** (it's the final state). | ☐ |
| 3.11 | Open **SYN-INV-010** (Retained) → **Provide** to `Test Employee 52` | Moves to Active Laptops as Active. | ☐ |
| 3.12 | **Add asset** → Name `Dell Latitude 7450`, Category `Laptop`, Serial `SYN-INV-300` → **Add asset** | Appears at the top of the list as Available. | ☐ |
| 3.13 | **Add asset** again with Serial `SYN-INV-300` | An error (duplicate key); nothing is added. | ☐ |
| 3.14 | **Add asset** with Serial ` SYN-INV-300` (leading space) | **⚠ KNOWN BUG M1:** it is accepted as a *different* laptop — spaces aren't trimmed. | ☐ |

---

## 4. Active Laptops (NP)

| # | Do | Expect | ☐ |
|---|---|---|---|
| 4.1 | **Active Laptops (NP)** | Shows `SYN-NP-001`…`012`, the moved `SYN-INV-001`…`005`, `SYN-DUP-C` and ` SYN-DUP-C`. Assigned ones show status **Active**. | ☐ |
| 4.2 | Open **SYN-NP-010** (Available) → **Provide** to `Test Employee 53` | Status Active; **stays** in Active Laptops (it's a genuine NP laptop, so it never moves). | ☐ |
| 4.3 | Same laptop → **Collect** | Status Available, still in Active Laptops. | ☐ |
| 4.4 | Open **SYN-INV-002** (Active, Test Employee 02) → **Decommission (employee left)** | Taken to **Laptop Inventory**, status Decommissioned, unassigned. Buttons: Provide, Retain, Mark damaged (decommissioned laptops can be reissued). | ☐ |
| 4.5 | Open **SYN-NP-004** (Active) → **Mark damaged** | **⚠ KNOWN BUG H6:** it stays in Active Laptops as *Damaged* and **still shows Assigned to** the employee. | ☐ |

---

## 5. Swap

| # | Do | Expect | ☐ |
|---|---|---|---|
| 5.1 | Active Laptops → open **SYN-NP-001** (Active, Test Employee 06) → **Swap** | A Swap panel; the replacement list shows available/decommissioned laptops from **both** Active Laptops and Laptop Inventory. | ☐ |
| 5.2 | Click **Confirm swap** with nothing chosen | Button is disabled until a device and a reason are given. | ☐ |
| 5.3 | Choose **SYN-INV-015**, reason `cracked screen` → **Confirm swap** | SYN-NP-001 becomes **Damaged**, unassigned, with a *swap* history entry naming SYN-INV-015. | ☐ |
| 5.4 | Open **Active Laptops** → **SYN-INV-015** | Now in Active Laptops, **Active**, Assigned to **Test Employee 06**, history *swap* … "Replaces serial SYN-NP-001". | ☐ |

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
| 9.4 | **Laptop Inventory** → import `02-inventory-with-errors.xlsx` (map Status too) | Preview: To create 1, **Errors (skipped) 3** — "Missing serial", "Invalid status "broken"", "Duplicate serial in this sheet". Commit → 1 created (`SYN-INV-201`). | ☐ |
| 9.5 | Check **Import History** for 9.4 | **⚠ KNOWN BUG M3:** shows **0 errored**, although 3 rows were skipped. | ☐ |
| 9.6 | **Active Laptops (NP)** → note SYN-NP-002 is Active / Test Employee 07 → import `03-KNOWN-BUG-np-status-reset.xlsx` | **⚠ KNOWN BUG C4 (the import-corruption bug):** preview says Update 3 with no warning; after commit SYN-NP-001…003 are **Available and unassigned** — their assignments were wiped because the sheet had no Status/Assigned-to columns. | ☐ |
| 9.7 | **Laptop Inventory** → import `04-KNOWN-BUG-case-mismatch.xlsx` | **⚠ KNOWN BUG H2:** preview says **Update** (it matched SYN-INV-012 ignoring case) but commit says **1 created** — a second laptop `syn-inv-012` now exists. | ☐ |
| 9.8 | **Laptop Inventory** → import `05-KNOWN-BUG-cross-collection.xlsx` (SYN-INV-001 is assigned to Test Employee 01, so it lives in Active Laptops) | **⚠ KNOWN BUG H3:** preview says **Create**; a second `SYN-INV-001` appears in Laptop Inventory while the real one is in Active Laptops. | ☐ |
| 9.9 | After 9.8: Active Laptops → **SYN-INV-001** → **Collect** | Fails with a duplicate-key error — the duplicate from 9.8 blocks the move back. | ☐ |
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
| 10.2 | `SYN-INV-003` | Opens it in **Active Laptops (NP)** (it was provided, so it moved). | ☐ |
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
| 11.4 | Assign equipment → Serial `SYN-INV-023` → **Assign device** | *Equipment assigned* ticks itself; "Assigned device" shows SYN-INV-023. In **Active Laptops** it's Active, Assigned to Test Employee 60, moved from Inventory. | ☐ |
| 11.5 | New onboarding `Test Employee 61` → serial `SYN-NEW-500` | Asks for device name and category ("That serial isn't in Active Laptops (NP) yet…"). Enter `Lenovo ThinkPad T14` / `Laptop` → assigned; a new laptop SYN-NEW-500 exists in Active Laptops. | ☐ |
| 11.6 | New onboarding `Test Employee 62` → serial `SYN-INV-006` (Damaged) | Error "Device SYN-INV-006 is not available to assign (currently damaged)"; nothing changes. | ☐ |
| 11.7 | Active Laptops → **SYN-INV-023** (from 11.4) → **Collect** | **⚠ KNOWN BUG C2:** fails with a foreign-key error — a laptop assigned through onboarding can't be collected. | ☐ |
| 11.8 | Tick **Required access provided** and **Onboarding successful** for Test Employee 60 | Both save. | ☐ |

---

## 12. Offboarding

| # | Do | Expect | ☐ |
|---|---|---|---|
| 12.1 | **Offboarding** | Test Employee 01 and 02 (synthetic). | ☐ |
| 12.2 | **Start offboarding** → `Test Employee 04` → **Start** | Checklist (Removed access, Laptop received, Laptop retained, Laptop decommissioned) and "Assets currently assigned to Test Employee 04" listing laptop **SYN-INV-004** (in Active Laptops). | ☐ |
| 12.3 | Same page | **⚠ KNOWN BUG H5:** Test Employee 04 also has monitor **SYN-MON-004**, but it is **not listed** — offboarding only looks at laptops. | ☐ |
| 12.4 | Tick **Removed access** and **Laptop received** | They save, and the laptop is **still assigned** — ticking the checklist never collects equipment by itself (by design). | ☐ |
| 12.5 | Click the listed laptop → **Collect** | It returns to Laptop Inventory, Available. Back on the offboarding page it's no longer listed. | ☐ |
| 12.6 | **Start offboarding** → `Test Employee 10` | Lists that employee's NP laptop **SYN-NP-005**. | ☐ |

---

## 13. Backup and restore

Do these **after** a few changes above, so there is something to compare.

| # | Do | Expect | ☐ |
|---|---|---|---|
| 13.1 | **Export backup** → **Export backup** | Downloads `equipment-ledger-backup-<date>.json`. | ☐ |
| 13.2 | Make one visible change: Monitors → **SYN-MON-011** → **Retain** | Status Retained. | ☐ |
| 13.3 | **Import backup** → choose the file from 13.1 | A red warning, "About to restore … wiping all current data", and a box asking you to type **RESTORE**. The red button stays disabled until you do. | ☐ |
| 13.4 | Type `RESTORE` → **Restore and overwrite everything** | "Backup restored at …". **SYN-MON-011** is **Available** again; everything else matches the moment of export. | ☐ |
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
