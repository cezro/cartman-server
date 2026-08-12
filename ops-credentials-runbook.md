# Ops runbook — the credentials and accounts nobody can create from code

**For whoever holds the Firebase, Google Play, Render and Supabase accounts.**
Written 2026-08-11. Self-contained: assumes no knowledge of the codebase and no
Flutter toolchain. Every task here is blocked purely on access — the code side
is finished and merged for all five.

> **Copy, not original.** The canonical version lives in the `cartman-mobile`
> repo at `docs/ops-credentials-runbook.md`; this copy was taken 2026-08-13
> from `fe15a81` so that cartman-server's own handoff can point at something
> in-repo. **Edit the mobile copy and re-copy** rather than diverging here —
> `server-handoff.md` sat stale in this repo for six days doing exactly that.

Ordered by what unblocks the most people.

| # | Task | Blocks | Rough time |
|---|---|---|---|
| 1 | [Promote an admin account](#1-promote-an-admin-account) | Rider and store approvals — **anyone signing up right now is stuck** | 5 min |
| 2 | [Mapbox billing alert](#2-mapbox-billing-alert) | Nothing, but the token is live and metered **today** | 10 min |
| 3 | [Firebase service account](#3-firebase--push-notifications) | All push notifications | 45 min |
| 4 | [Android release keystore](#4-android-release-keystore) | Testers having to uninstall before every update | 20 min |
| 5 | [Verify account deletion](#5-verify-account-deletion-end-to-end) | App Store / Play review | 15 min |

**The identifiers, once, because two of these tasks fail silently if they are
wrong:**

| | Customer app | Rider app |
|---|---|---|
| Android package (`applicationId`) | `com.cartman.cartman_customer` | `com.cartman.cartman_rider` |
| iOS bundle ID | `com.cartman.cartmanCustomer` | `com.cartman.cartmanRider` |
| OAuth deep-link scheme (**different on purpose**) | `com.cartman.customer://login-callback` | `com.cartman.rider://login-callback` |

> Note the doubled word in the Android package names. `com.cartman.customer` —
> without it — is the *deep-link scheme*, not the package, and an older version
> of `docs/backend-ops-tasks.md` listed it as the package. Registering that in
> Firebase produces a `google-services.json` the app rejects at startup, so
> **copy the package names from the table above, not from memory.**

Supabase project: **CartmanPH**, ref `jxyromcmejhmhkgpydmy`.

---

## 1. Promote an admin account

**Why it is first.** Rider and merchant approvals are gated on
`profiles.role = 'admin'`, and **no account in production has that role.** So
today: a rider signs up, sees "we're reviewing your account", and nothing can
ever review it. Same for a store. Everything else on this page can wait a week;
this one is actively blocking sign-ups.

`role` is a plain `text` column on `public.profiles`, defaulting to
`'customer'`. Nothing in either app can set it — deliberately, since a
self-service admin flag was a real vulnerability here once (H15). It is a
manual database write, and it is meant to stay one.

### Steps

1. Have the person who will be admin **sign up in the customer app normally**,
   with the email they will use. They need a real account row first.
2. Open the Supabase dashboard → **CartmanPH** → **SQL Editor**.
3. Confirm the account exists and check what it looks like now:

   ```sql
   select id, full_name, role from public.profiles
    where id = (select id from auth.users where email = 'admin@example.com');
   ```

   One row, `role = 'customer'`. **If you get zero rows, stop** — the sign-up
   did not complete, and the next statement would silently update nothing.
4. Promote:

   ```sql
   update public.profiles
      set role = 'admin'
    where id = (select id from auth.users where email = 'admin@example.com');
   ```

   It should report `UPDATE 1`. `UPDATE 0` means the email did not match.
5. Verify through the same function the app's gates use, rather than by
   re-reading the column:

   ```sql
   select public.is_admin(
     (select id from auth.users where email = 'admin@example.com')
   );
   ```

   Must return `true`.
6. Have them **sign out and back in** on the Merchant Panel. The admin console
   appears in the nav once the role is on their profile.

### Confirming it worked

They should see a review queue with any pending riders and stores in it, and be
able to approve one. If the console is not in the nav, it is almost always
step 6 — the role is read from the session, so a session issued before the
promotion does not have it.

> **Keep this list short.** An admin can approve riders and stores, cancel and
> unassign any order, and read the audit trail. Every decision is recorded with
> its actor in `verification_events`, so the promotion is traceable — but the
> promotion itself is only as controlled as who can run SQL.

---

## 2. Mapbox billing alert

`MAPBOX_TOKEN` is set on cartman-server and is serving address search **right
now**. It is a metered, paid API, and `CLAUDE.md` §3.1 made a billing alert a
condition of using it at all. That condition is currently unmet.

Address search is type-ahead, so one customer typing one address is several
requests. There is a server-side cache in front of it and the app now caches
within a session too, but the exposure is real and unbounded.

### Steps

1. Mapbox account → **Billing** → set a **usage alert** on the Geocoding API
   at a monthly request threshold you are willing to pay for.
2. Add a **hard limit** if the plan offers one. An alert tells you after the
   fact; a limit is what actually stops a runaway.
3. Confirm the token in use is a **secret `sk.*` token** and is scoped to
   geocoding only.
4. Confirm it exists **only** as an environment variable on cartman-server
   (Render → the service → **Environment**). It must never appear in this
   repo, in either app, or in the Merchant Panel — a token shipped in an APK
   is extractable and cannot be rotated quietly.

### Confirming it worked

Trigger the alert threshold deliberately low for a minute (e.g. set it to 1),
confirm the email arrives, then set it to the real number. An alert nobody has
ever seen fire is an alert you are trusting on faith.

---

## 3. Firebase — push notifications

**What already works, so you do not go looking for it:** the sending code is
written and deployed, the database decides who to notify and queues it, and
both apps register their device tokens. The **only** missing pieces are the
credentials below and one server-side loop (that loop is a developer task, not
yours — it is tracked as "the L3 drainer").

Until the credentials exist, the send function answers success with "sent: 0"
by design, so nothing errors and nothing arrives.

### 3a. Create the Firebase project and register both apps

1. [Firebase console](https://console.firebase.google.com) → **Add project**.
   One project covers both apps.
2. Add an **Android** app for **each** package — both, not one:
   - `com.cartman.cartman_customer`
   - `com.cartman.cartman_rider`

   (Check these against the table at the top. This is the step that fails
   silently if it is wrong.)
3. Download each `google-services.json` and place them at:
   - `apps/customer/android/app/google-services.json`
   - `apps/rider/android/app/google-services.json`

   These files are **git-ignored on purpose** — hand them to the developer
   directly, do not commit them or paste them into a ticket.
4. iOS, only when iOS is in scope: add an iOS app per bundle ID
   (`com.cartman.cartmanCustomer`, `com.cartman.cartmanRider`), download each
   `GoogleService-Info.plist`, and hand those over the same way. Push on iOS
   also needs an **APNs key** (.p8) uploaded to Firebase → Project settings →
   Cloud Messaging.

### 3b. Create the service account and set the three secrets

1. Firebase console → **Project settings** → **Service accounts** →
   **Generate new private key**. A JSON file downloads. Treat it like a
   password: it can send a notification to every user of the app.
2. Open it and take three fields: `project_id`, `client_email`, `private_key`.
3. Set them as **Supabase Edge Function secrets** (not Render — the sender is a
   Supabase Edge Function):

   ```bash
   supabase secrets set --project-ref jxyromcmejhmhkgpydmy \
     FCM_PROJECT_ID='your-project-id' \
     FCM_CLIENT_EMAIL='firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com' \
     FCM_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n'
   ```

   Or via the dashboard: **Edge Functions** → **Secrets**.

> **`FCM_PRIVATE_KEY` is where this task usually goes wrong.** The JSON stores
> the key with literal `\n` two-character sequences in it. Paste it **exactly
> as it appears in the JSON**, including those `\n`, and wrap it in single
> quotes so the shell does not interpret them. If you paste a version with real
> line breaks, or strip the `\n`, the key fails to parse and every send returns
> an auth error rather than anything that names the real problem.

4. Delete the downloaded JSON from your machine once the secrets are set.

### Confirming it worked

Ask the developer to call the `push-send` function with a test payload. Before
the credentials it answers `{"sent": 0}`; after, it answers with a real send
count. That number changing from 0 is the whole test — no app build required.

---

## 4. Android release keystore

Right now release builds fall back to the **debug** signing key, because the
signing config file is git-ignored and absent. Consequences the testers are
already living with:

- Every new build must be **uninstalled before installing** — Android refuses
  to replace an app when the signing key changes.
- Uninstalling wipes local data, so nobody can test anything that depends on
  what was there before an update.
- These builds can never go to Play. **Play locks a package to its first
  signing key permanently**, so the key you generate here is effectively
  forever — back it up before you ship with it.

### Steps

1. Generate one keystore. The same key can sign both apps:

   ```bash
   keytool -genkey -v -keystore ~/cartman-release.jks \
     -keyalg RSA -keysize 2048 -validity 10000 -alias cartman
   ```

   It asks for a keystore password, a key password and a name/org. Record all
   of it in your password manager **before** continuing.
2. **Back up the `.jks` file somewhere durable and private.** Losing it means
   you can never update the app on Play under that package name again. This is
   not recoverable by anyone, including Google.
3. Copy the example file in each app and fill it in:

   ```bash
   cp apps/customer/android/key.properties.example apps/customer/android/key.properties
   cp apps/rider/android/key.properties.example    apps/rider/android/key.properties
   ```

   Each holds the store password, key password, alias, and the **absolute path**
   to the `.jks`.
4. Confirm `key.properties` and the `.jks` are **not** committed — both are
   git-ignored already; do not "fix" that.

### Confirming it worked

Have the developer build a release APK and check the signer:

```bash
keytool -printcert -jarfile <the-apk>
```

The owner line should be what you typed in step 1, not "Android Debug". Then
install it over an existing debug-signed build — it should **fail**, and after
one final uninstall every future update should install cleanly on top.

---

## 5. Verify account deletion end to end

Apple 5.1.1(v) and Google Play both require real deletion, and reviewers check
it. The code shipped: the app tombstones the profile and signs the user out,
and an hourly server job then deletes the underlying login. **Nobody has ever
watched that job actually do it**, which is the only reason this is on the
list. If it silently fails, the credentials keep working after a "deleted"
account — which is exactly the thing review rejects for.

### Steps

1. Sign up a throwaway account in the customer app. Note the email. **Do not
   place an order with it** — orders are the merchant's sales records, so the
   profile is deliberately not deletable while it has any, and you would be
   testing the blocker rather than the deletion.
2. In the app: **Profile → Delete account** → confirm. It should sign you out.
3. In the Supabase SQL Editor, confirm the tombstone:

   ```sql
   select id, deleted_at, auth_deleted_at from public.profiles
    where id = (select id from auth.users where email = 'throwaway@example.com');
   ```

   Expect `deleted_at` set. `auth_deleted_at` will still be null — the sweep
   has not run yet.
4. **Wait for the next hourly run**, then re-run the query above. Now expect
   `auth_deleted_at` set too.
5. The real test — confirm the login is gone:

   ```sql
   select count(*) from auth.users where email = 'throwaway@example.com';
   ```

   Must be **0**.
6. Try to sign in with those credentials in the app. It must fail.

### Confirming it worked

Step 5 returning 0 and step 6 failing to sign in. If step 4 never stamps
`auth_deleted_at`, the sweep is not running — that is a cartman-server issue to
hand back to the developers, with this query as the evidence:

```sql
select id, deleted_at from public.profiles
 where deleted_at is not null and auth_deleted_at is null;
```

Rows here are accounts the user asked to delete and whose logins still work.
That list should drain to empty within an hour of each deletion; if it grows,
the job is down.

---

## What is deliberately not on this list

- **`MAPBOX_TOKEN` itself** — already set and working. Only the billing alert
  is outstanding (§2).
- **Supabase keys** — already configured. The anon key is in the apps by design
  (row-level security is what protects the data); the service-role key is on
  cartman-server only and must stay there.
- **The push drainer** — the last piece of code between the queue and an actual
  notification. Developer task, tracked in `server-handoff.md` §1 (this repo).
- **Client FCM wiring** — neither mobile app declares `firebase_messaging` yet,
  so no device token is ever obtained. Developer task in `cartman-mobile`, found
  2026-08-13. It needs §3 of this runbook done first, but nothing you do.
- **Anything about the Admin Dashboard app** — not built from this repo.
