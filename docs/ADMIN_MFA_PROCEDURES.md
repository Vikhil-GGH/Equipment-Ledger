# Admin two-factor procedures (staging and production)

Since migration 031, an admin has **no access at all** without a two-factor (aal2) session. They can see only their own profile, and the app sends them to the code prompt or the Security page. Nobody can be **made** an admin, through the app or a direct database connection, unless they already have a verified authenticator. There's no bypass, so the procedures below never weaken that.

Terms:
- **Owner:** the person with Supabase dashboard access to the project.
- **Admin A / Admin B:** the two application admins.

Production should always have **two** admins with two-factor. Then a lost phone never needs the dashboard, except to remove the old factor.

## 1. First admin (bootstrap)

There's no admin yet who could promote anyone in the app, so the owner does it once, from the SQL editor, **after** the person has enrolled.

1. **Create the login (owner):** Dashboard → Authentication → Users → Add user, with the person's work email. Use an invitation, or a strong temporary password given out of band.
2. **Enrol (the person):**
   1. Sign in. The account starts as a **viewer**.
   2. Open **Security** (sidebar footer).
   3. Click **Set up two-factor authentication**, scan the QR code and enter the code.
   4. Check that the page says *On (this session is verified)*.
3. **Promote (owner, SQL editor):**
   ```sql
   update profiles set role = 'admin'
   where email = 'person@company.com'
     and exists (select 1 from auth.mfa_factors f where f.user_id = profiles.id and f.status = 'verified')
   returning email, role;
   ```
   Exactly **one** row must come back. No rows means they haven't finished enrolling, so stop. The database refuses the promotion anyway without a verified factor.
4. **Check (the person):** sign out, sign in with password + code. **Access & Roles** must appear.
5. **Record it** in the change log: who, when, who promoted them.

Never promote someone before they've enrolled, and never "temporarily" remove the rule.

## 2. Second admin

1. The person signs in (viewer), enrols on **Security** and verifies (as in step 2 above).
2. Admin A, signed in with a code, opens **Access & Roles** and sets them to **admin**. If they haven't enrolled, the app shows: *"They need to set up two-factor authentication … before they can be made an admin"*.
3. They sign out and back in with their code.

## 3. New phone (both phones available)

1. On **Security**: **Replace authenticator (new phone)** → scan with the new phone → enter its code.
2. The old authenticator is removed **only after** the new one is verified. If that removal fails, the page says so: use **Remove old authenticators**.
3. Sign out and back in with the new phone's code.

## 4. Lost phone or authenticator (the other admin is available)

The aim is that no admin is ever without an authenticator.

1. **Admin B** (with code) sets Admin A to **editor** in Access & Roles. A keeps working as an editor without two-factor; nothing is lost.
2. **Owner:** Dashboard → Authentication → Users → Admin A → remove the lost MFA factor. Confirm A's identity by phone or video call first.
3. **Admin A** signs in and enrols a new authenticator on **Security**.
4. **Admin B** sets Admin A back to **admin**. The database refuses this until step 3 is done.
5. Record steps 1–4 with times.

## 5. Both admins lost their authenticators (emergency)

1. **Owner:** confirm the person's identity, then reset their password (Dashboard → Users → Send password recovery). This blocks anyone who knows the old password.
2. **Owner:** remove the person's lost factor in the dashboard.
3. **The person:** they're still an admin but have no access, so the app shows only the Security page. They enrol immediately and sign in again with the code. Do steps 1–3 **together, live**, so there's no window in which the account is an admin with no authenticator.
4. They then fix the second admin as in section 4.
5. Record everything.

## 6. An admin leaves

1. The other admin uses **Remove access** in Access & Roles (audited; history kept).
2. If 032 is adopted, their sign-in is also blocked automatically. Otherwise the owner bans the user in the dashboard.
3. Promote a replacement as in section 2 **before** the leaver's last day if possible. The last active admin can't be removed.

## 7. Regular checks (monthly)

- Each admin signs in with the code once (proves the phone still works).
- The production preflight's "Admins and two-factor" line must read *N of N admins have a verified authenticator*.
- Check Access & Roles for anyone who shouldn't be there.
