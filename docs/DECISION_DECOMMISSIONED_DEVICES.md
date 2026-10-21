# Decision: may a Decommissioned device be issued again?

**Status:** recommendation for the owner. No behavior was changed.

## How it works today
- **Serialized devices (laptops, monitors, other equipment).** `decommissioned` is *not* terminal. The README documents it as "the employee who had the device left; the device is refreshed and re-enters the reissue pool". From Decommissioned the device page offers **Provide**, **Retain** and **Mark damaged**. The button that sets it is labelled "Decommission (employee left)".
- **Where it can be re-issued from.** Only by an explicit **Provide** on the device page (or the by-serial onboarding assign), and since 033/034 only if the device is unassigned and has no open register issue. The register/onboarding picker (`issue_equipment`) offers **Available devices only**, so a Decommissioned device is never offered as ready stock.
- **Truly final states** already exist: *Mark non-functional* (from Damaged) and *Lost*.
- **Bulk Stock** is different: its *Decommissioned* bucket means written off and has no way back.
- **Offboarding wording.** The return outcome "Returned for decommission" and the checklist choice "Laptop decommissioned" read like retirement, not "needs a refresh".

## The risk
One word means two things (refresh pending vs retired), and a single click on the device page can hand a *retired* device to a new employee.

## Recommendation (small, low risk; needs your OK because it is a business-rule decision)
Keep the current rule (Decommissioned devices can be reissued), because it matches how laptops are actually recycled here, and add two guard rails:
1. **Make the reissue deliberate.** When Provide is pressed on a Decommissioned device, ask "Has this device been refreshed and is it fit to issue?" and record the answer in the history note. (UI only; no schema change.)
2. **Say what it means.** Show "Decommissioned: refresh needed before reissue" beside the status, and use *Mark non-functional* (via Damaged) for hardware that is truly retired.

Alternative (not recommended now): make Decommissioned terminal. It is a data and workflow change: existing decommissioned devices would be stranded, and every refresh would need a new status.

## Needed from you
Reply "approve guard rails" (or "terminal" / "leave as is") and I implement it locally with tests.
