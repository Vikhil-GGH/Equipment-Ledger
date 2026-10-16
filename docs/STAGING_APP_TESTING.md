# Equipment Ledger — Manual Test Plan (Staging)

Use this to test the **whole application in your browser, as the administrator**, against the staging project — before approving any production change. Everything here uses **synthetic data only** and **never touches production**.

**Before you start:** finish [STAGING_SETUP.md](STAGING_SETUP.md) Steps 1–11 (staging project, settings file, migrations 001–023, accounts, synthetic data, anonymous sign-ins turned off).

How to use this document:
- Work top to bottom. Each test says **Do** and **Expect**.
- Tick ☐ → ☑ as you go, and note anything that differs.
- Items marked **⚠ KNOWN BUG** are problems found in the audit that are **not fixed yet**. They're included so you can see them for yourself — the "Expect" describes the *current, wrong* behaviour. Reset staging afterwards ([section R](#r--resetting-staging-between-test-rounds)).
- If something fails that is *not* marked as a known bug, note the section number, what you did, and what you saw.
- **Testing changes staging.** Use the synthetic records named here; never test on records you want to keep as they are, and run `npm run staging:reset` to start clean.

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
| 9.3 | Import `01-monitors-new.xlsx` **again** | Preview: **Already in the ledger 4**. Commit → "0 created, 0 updated, 4 already up to date" — no duplicates and **no new history entries** on those monitors (open one: still just *created*). | ☐ |
| 9.4 | **Laptop Inventory** → **Import from Excel** → **Serialized Assets** (= Company laptops) → import `02-inventory-with-errors.xlsx` (map Status too) | Preview: To create 1, **Errors (skipped) 3** — "Missing serial", "Invalid status "broken"", "Duplicate serial in this sheet". Commit → 1 created (`SYN-INV-201`). | ☐ |
| 9.5 | Check **Import History** for 9.4 | **⚠ KNOWN BUG M3:** shows **0 errored**, although 3 rows were skipped. | ☐ |
| 9.6 | Note SYN-NP-002 is Active / Test Employee 07 → **Import from Excel** → **Active Laptops (NP)** → import `03-np-reimport-no-status.xlsx` | *(Was bug C4, fixed by migration 027.)* Preview: Already in the ledger 3, with a note that imports never change status or assignment. After commit SYN-NP-001…003 are **still Active and assigned to the same people**; only a changed Location is updated. | ☐ |
| 9.7 | **Laptop Inventory** → import `04-case-mismatch.xlsx` | *(Was bug H2.)* Preview: **Existing**; commit: "1 already up to date". No second laptop `syn-inv-012`. | ☐ |
| 9.8 | **Laptop Inventory** → import `05-cross-collection.xlsx` (SYN-INV-001 is assigned to Test Employee 01, so it lives in Active Laptops) | *(Was bug H3.)* Preview: **Existing**; commit: already up to date. Only **one** SYN-INV-001, still in Active / Assigned. | ☐ |
| 9.9 | After 9.8: Laptop Inventory → the **SYN-INV-001** in Active / Assigned → **Collect** | Works (no duplicate to block the move). | ☐ |
| 9.10 | **Bulk Stock** → import `06-bulk-received.xlsx` (map Quantity) | Preview: Update 1 (Wireless Mouse), Create 1 (Webcam, unless added in 8.8). Commit → Wireless Mouse Available +10. | ☐ |
| 9.11 | Import `06-bulk-received.xlsx` **again** | **⚠ KNOWN BUG H4:** Wireless Mouse goes up by **another 10** — the same file counted twice. | ☐ |
| 9.12 | **Other Equipment** → import `07-KNOWN-BUG-header-space.xlsx` | **⚠ KNOWN BUG M5:** the column shows as "Serial" in the mapping, but the preview shows **Missing serial** on every row (the sheet's header is "Serial " with a trailing space). | ☐ |
| 9.13 | Upload any `.json` or `.txt` file | An error "Could not read that file" or "No data found"; nothing imported. | ☐ |
| 9.14 | **Active Laptops (NP)** import `08-status-conflict.xlsx` (map Status and Assigned to) | Commit → "**Not applied — 2 status or assignment differences**": SYN-NP-002 status is "provided", sheet says "available"; assigned to is "Test Employee 07", sheet says "Someone Else". The serial links to the laptop, which is **unchanged**. | ☐ |
| 9.15 | **Laptop Inventory → Serialized Assets** import `09-new-assigned.xlsx` (map Status and Assigned to) | "1 created" (SYN-INV-204) and "**Skipped — 1 row**": SYN-INV-203 can't be imported as assigned/Provided — it was not created. | ☐ |
| 9.16 | **Monitors → Add asset** with serial `syn-inv-021` (a laptop's serial, lower case) | Refused: "Serial number "syn-inv-021" already exists … each device needs its own serial". Same for ` SYN-INV-021 ` with spaces. | ☐ |
| 9.17 | **Access & Roles** → *Devices sharing a serial number* | The synthetic duplicates SYN-DUP-A (Laptop Inventory + Monitors), SYN-DUP-B / syn-dup-b, SYN-DUP-C / " SYN-DUP-C" — read-only, each linking to its device; they still open and work normally. | ☐ |

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

## 11. Onboarding — checklist and equipment assignment

Staging now has the **employee equipment register** (migrations 025–026). Every onboarding and offboarding record is linked to an **employee record**, and everything issued to that employee is tracked until it comes back. The checklist and the equipment section are tracked **separately**.

| # | Do | Expect | ☐ |
|---|---|---|---|
| 11.1 | **Onboarding** | The table (Test Employee 30, 31, 32 after a reset). Onboarding and Offboarding are **separate** sidebar items. | ☐ |
| 11.2 | **Start onboarding** → type `Test Employee 30` | Because that name already exists, the dialog asks **"is it the same person?"** — *Yes — Test Employee 30* or *No — a different person*. **Start** stays disabled until you choose. Cancel. | ☐ |
| 11.3 | **Start onboarding** → `Test Employee 60` → **Start** | "A new employee record will be created". Opens the checklist (four steps) and, below it, **Equipment assignment**. | ☐ |
| 11.4 | Look at **Charger required?** and **Headset required?** | Three options each — **Yes / No / N/A** — and **none selected**; "Not answered yet — choose Yes, No or N/A". | ☐ |
| 11.5 | Type a **Requested laptop** (e.g. `14-inch, 16 GB`) → **Save**, reload | Still there. | ☐ |
| 11.6 | **Laptop** → search `SYN-INV-02` → choose **SYN-INV-021** → **Issue laptop** | *Equipment assigned* ticks itself; the summary says "Laptop: 1 issued"; the issued-equipment list shows it as **Pending return**. In Laptop Inventory it's under **Active / Assigned** for Test Employee 60. | ☐ |
| 11.7 | Choose another laptop (**SYN-INV-022**) → **Issue another laptop** | Two laptops issued to the same employee, each its own row. | ☐ |
| 11.8 | **Charger required? → Yes** | Only the answer is saved — **nothing is issued**. An **Issue charger** picker appears. | ☐ |
| 11.9 | Choose **USB-C Charger** → **Issue charger** | Issued. Bulk Stock → USB-C Charger: Available −1, Provided +1, and "Provided … = 1 tracked to named employees + … issued before tracking began". | ☐ |
| 11.10 | **Headset required? → Yes** → source **From Other Equipment** → choose a headset (e.g. **SYN-OTH-004**) → **Issue headset** | Issued; the headset is Provided to Test Employee 60. (Try **From Bulk Stock** on another employee if a Headset bulk item exists.) | ☐ |
| 11.11 | Change **Headset required?** to **No** | The answer changes, the headset **stays issued**, and a note says to return it from Offboarding if needed. | ☐ |
| 11.12 | Start onboarding `Test Employee 61` → **Charger required? → N/A**, **Headset required? → No** | No Issue buttons for either; summary says "Not required". | ☐ |
| 11.13 | Tick **Required access provided** and **Onboarding successful** for Test Employee 60 | The checklist shows 4/4 **Completed** on the Onboarding list — equipment status is separate. | ☐ |

---

## 12. Offboarding — checklist and equipment return

The checklist is **two required steps**: **Removed access** and **one laptop outcome** (received / retained / decommissioned / Not applicable). Below it, **Equipment return** lists **everything issued to the employee** and processes each item on its own, updating the real inventory at the same time. Recording the checklist outcome never changes equipment.

| # | Do | Expect | ☐ |
|---|---|---|---|
| 12.1 | **Start offboarding** → `Test Employee 60` → confirm **Yes — Test Employee 60** → **Start** | Checklist at 0/2, and **Equipment return** listing both laptops, the charger and the headset from section 11 — type, item, serial, quantity, issued date, **Pending return**. "4 pending return · 0 of 4 processed". | ☐ |
| 12.2 | Laptop **SYN-INV-021** → **Process return** | Five outcomes, **none pre-selected**; **Confirm** disabled. | ☐ |
| 12.3 | Choose **Returned** | The panel says exactly what will happen: "Collect: the device becomes Available and unassigned." → **Confirm**. | ☐ |
| 12.4 | Check | SYN-INV-021 → **Returned**; **SYN-INV-022 still Pending return** and still assigned in Laptop Inventory. "3 pending return · 1 of 4 processed". | ☐ |
| 12.5 | Charger → **Process return** → **Retained — authorized** | "Reason (required)"; Confirm disabled until you type one (e.g. `Approved by HR`). Effect: "written off from Provided (not Available, not pending)". Confirm → status **Retained — authorized** with your reason. Bulk Stock: Provided −1, Decommissioned +1 — never Available. | ☐ |
| 12.6 | Headset → **Returned damaged** → Confirm | The headset becomes **Damaged** and unassigned in Other Equipment. | ☐ |
| 12.7 | SYN-INV-022 → **Lost / not recoverable** → reason `left in a taxi` → Confirm | SYN-INV-022 becomes **Lost** (Laptop Inventory → Other), unassigned, with no further actions on its page; its history shows *mark_lost* with the reason. | ☐ |
| 12.8 | The progress line | "All items processed · 4 of 4 processed · 1 retained (authorized) · 1 lost" — the **checklist** above is still 0/2 (they're separate). | ☐ |
| 12.9 | Tick **Removed access**, choose **Laptop received** | Checklist 2/2 → Completed on the Offboarding list. | ☐ |
| 12.10 | **Test Employee 46 (legacy conflict)** (after a reset) | Offboarding list shows **⚠ Laptop outcome needs review**; the page names the two ticked outcomes and pre-selects none. | ☐ |
| 12.11 | Offboarding for **Test Employee 04** | Equipment return lists laptop **SYN-INV-004** *and* monitor **SYN-MON-004** (the old "laptops only" gap, H5, is closed). | ☐ |

Elsewhere:

| # | Do | Expect | ☐ |
|---|---|---|---|
| 12.12 | Laptop Inventory, after a laptop was marked **Retained — authorized** | That laptop shows "Retained by former employee (authorized)" under its status. | ☐ |
| 12.13 | **Access & Roles** | A "Possible duplicate employees" list (read-only; "None found" on fresh synthetic data). | ☐ |

---

## 13. Backup and restore

Do these **after** a few changes above, so there is something to compare.

| # | Do | Expect | ☐ |
|---|---|---|---|
| 13.1 | **Export backup** → **Export backup** | Downloads `equipment-ledger-backup-<date>.json` and says "Backup downloaded: *N* rows from 15 tables, every table checked complete". | ☐ |
| 13.2 | Make one visible change: Monitors → **SYN-MON-011** → **Retain** | Status Retained. | ☐ |
| 13.3 | **Import backup** → choose the file from 13.1 | A red warning, "About to restore … wiping all current data", the number of rows and tables, "Row counts checked against the export…", and a box asking you to type **RESTORE**. The red button stays disabled until you do. | ☐ |
| 13.4 | Type `RESTORE` → **Restore and overwrite everything** | "Backup restored at … — *N* rows across 15 tables, every count verified" (plus a note about the devices sharing a serial). **SYN-MON-011** is **Available** again; everything else matches the moment of export — including offboarding outcomes such as **Not applicable** and Charger/Headset Required answers. | ☐ |
| 13.5 | Choose a `.xlsx` or random `.json` file to restore | An error "does not look like an Equipment Ledger backup" (for a non-backup JSON), or a read error; nothing restored. | ☐ |

| 13.6 | Open the file from 13.1 in a text editor, delete one entry from `serialized_asset_history` (one `{ … },` block), save, and choose it to restore | Refused before anything is sent: "This backup is incomplete: serialized_asset_history has … rows but the export recorded …". | ☐ |

**Large tables (was bug C5, fixed):** run `npm run staging:reset -- --large` (adds 1,120 history rows), then **Export backup** → the file's `counts.serialized_asset_history` and the number of entries in `serialized_asset_history` are both the full number (over 1,000), and the success message counts them. Reset afterwards.

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
