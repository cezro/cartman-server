# Cartman — what's left, and it's all cartman-server

**For the cartman-server monorepo session.** Written to be self-contained: it
assumes no knowledge of `cartman-mobile` and states every contract it depends
on. Everything here is the remaining work before APKs go to a tester.

**Status elsewhere.** The database is done and applied to **CartmanPH**
(`jxyromcmejhmhkgpydmy`) — 135 tests green. The merchant panel is done — 69
tests green, tsc clean. Both mobile apps are feature-complete against every
spec; they need `melos run analyze` and a build, nothing more.

Ordered by what actually blocks a tester.

---

## Status in this repo — updated 2026-08-07

**§3 (I3b) and §4 (I2) are done.** Both shipped together, because working on
them turned up something neither this doc nor the gap register had: **food and
grocery orders were being created with no drop-off at all.**

Every other order type writes `dropoff_lat/lng/text` — errand, courier, ride,
multi-stop. `placeMerchantOrder` wrote none of them and nothing filled them in
later, so a live food order reached the rider feed with a null destination, and
the rider's active screen (which renders it only `if (order.dropoffText !=
null)`) showed them nowhere to go. The gap register's claim that
"cartman-server resolves it from the default" was not true of any code path.

**Correction to §3 and §4 below: this server does not call `place_order`.**
`OrdersService.placeMerchantOrder` writes `orders` directly through Prisma —
it is a parallel implementation of that RPC, not a caller. Anything phrased as
"pass it through to `place_order`" means "add it to the Prisma `create`". The
DB twin still matters for the mobile client's mock/direct path, so the two
write paths have to be changed together or they drift.

What landed:
- `dropoff_instruction` + `dropoff_note` accepted on the food/grocery DTO and
  written. Omitted ⇒ the DB default `hand_to_me` still applies.
- Per-order `dropoff_lat/lng/text` accepted (I2), so delivering elsewhere no
  longer has to promote that address to default.
- No coordinates in the body ⇒ resolve the customer's **default saved
  address**. No address at all ⇒ 400, because the alternative is a paid order
  the merchant cooks and nobody can deliver.
- `prisma/schema.prisma` had drifted from the applied database and is now
  synced for these columns: added the `dropoff_instruction` enum,
  `orders.dropoff_instruction`, `orders.dropoff_note`, and
  `profiles.deleted_at` / `deletion_reason` (§2 needs the last two).

**Remaining drift, deliberately not touched** — the DB also has
`orders.pod_photo_url`, `orders.pod_note`, `orders.delivered_at`, and the
tables `incident_reports`, `order_assignment_events`, `order_messages`,
`verification_events`, none of which are in `schema.prisma`. Adding a column
there changes what Prisma SELECTs and therefore what the API returns, so it is
a deliberate call rather than a tidy-up. Note `incident_reports` (cartman-mobile
H11) and this repo's own `incidents` table are two different systems.

Verified: **365 tests green, 37 suites** (was 360); `npm run build` clean.
`npx tsc --noEmit` reports 8 errors, all pre-existing in spec files and
identical to the count on `e0a1471`. The five new tests were mutation-checked —
removing the write makes three of them fail.

Still open here, in the doc's own order: §1 (L3 push), §2 (L5 sweep — the
schema is ready for it now), §5 (H10), §6 (H17), §7 (I8).

---

## 1. 🔴 L3 — Push notifications

Push is a stub end to end. `push-send` logs instead of sending, and no Firebase
credentials exist. **Nobody is told anything**, which now costs more than it
used to because three features added this week depend on a notification to
close their loop.

### Needs
- Firebase service account → `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`,
  `FCM_PRIVATE_KEY` as server secrets. (`docs/FCM_SETUP.md` in cartman-mobile
  has the console walkthrough.)
- `google-services.json` / `GoogleService-Info.plist` into the two apps —
  git-ignored by design, so they are handed over out of band.
- Real send in `push-send`.

### Device tokens already work
Both apps register through `POST /profiles/me/device-tokens` and clean up on
sign-out via `DELETE /profiles/me/device-tokens/:token`. The `device_tokens`
table is populated. Nothing on the client side is missing.

### What to send, and to whom
| Event | Who hears | Why it matters |
|---|---|---|
| Order placed | merchant | The panel chimes only while a tab is open |
| Order accepted / ready / picked up / arriving | customer | The whole tracking loop is silent otherwise |
| New order on the feed | on-duty riders | The feed is Realtime but the app may be backgrounded |
| **Rider approved** (H16) | that rider | They are shown "we're reviewing your account" and have no way to learn it changed except reopening the app |
| **Store approved** | that owner | Same shape — the panel says "awaiting approval" and never updates |
| **A merchant signed up** | admins | Nothing tells anyone a store is waiting; approvals are pull-only today |

The last three are new. They exist because the verification gates went live
this week and both default to false.

---

## 2. 🔴 L5 — The account-deletion sweep

**This is the half an app-store reviewer actually checks.** Apple 5.1.1(v) and
Google Play both require in-app account deletion, and the app has it — but the
deletion is not final without this.

### What already happens
`delete_my_account()` (RPC, shipped and applied) tombstones the profile:
name → `Deleted user`, phone → null, avatar → null, `deleted_at` set. Saved
addresses are erased. Store membership is dropped and a store left with no
members is closed. A rider is taken off duty and un-verified.

Orders deliberately **survive** — `orders.customer_id` has no `ON DELETE`, and
those rows are the merchant's sales history and the rider's ledger. PH
record-keeping outranks the erasure request; RA 10173's right to erasure is
explicitly subordinate to records required by law.

### What the server must add
The client cannot remove the `auth.users` row — that needs the service role,
which by design is nowhere near the app. Until it is gone the credentials still
work.

```ts
// Sweep on a schedule (hourly is plenty).
const { data } = await admin.from('profiles')
  .select('id').not('deleted_at', 'is', null);
for (const { id } of data ?? []) await admin.auth.admin.deleteUser(id);
```

The app already signs out on success and on any cold start whose profile
carries `deleted_at`, so the window is small — but "small" is not "closed", and
a reviewer will test exactly this.

### Blockers already enforced (do not duplicate)
`account_deletion_blockers()` refuses deletion for: a live order, an unsettled
rider wallet (they hold COD cash or are owed a payout — the ledger is
append-only), or being the sole member of a trading store. The app asks before
offering the button. The RPC re-checks anyway.

---

## 3. 🟠 I3b — Order routes drop the drop-off instruction

The customer can now choose **hand to me / leave at the door / meet at the gate
/ meet outside** plus a free-text note, and the rider's active screen shows it
prominently. It works in mock mode. **In live mode it goes nowhere.**

`POST /orders/food` and `/orders/grocery` accept `{merchant_id, items, notes}`
and forward exactly that. The two fields are dropped before they reach the
database.

### The DB is ready
`orders.dropoff_instruction` is an enum
(`hand_to_me | leave_at_door | meet_at_gate | meet_outside`, default
`hand_to_me`) and `orders.dropoff_note` is text. `place_order(payload jsonb)`
reads both — that was fixed and applied on 2026-08-06. Omitting the keys still
yields `hand_to_me`, so nothing changes for callers that do not send them.

### What to do
Accept `dropoff_instruction` and `dropoff_note` on the merchant order DTOs and
pass them through to `place_order`.

### ⚠️ Read this before touching the DTO
The client **already sends both fields optimistically**, and retries once
without them if the server answers 400. That was deliberate: if the
`ValidationPipe` uses `forbidNonWhitelisted`, an unknown property 400s the
whole request and **every food order breaks**. The retry means nothing is
broken today either way.

So: adding the fields to the DTO is safe and immediately switches the feature
on. What you must *not* do is add strict rejection of unknown fields without
adding these two first.

---

## 4. 🟠 I2 — Per-order drop-off (refinement)

Deliver-elsewhere works today by a side door: checkout promotes the chosen
address to **default**, and the server resolves the drop-off from the default.
Ordering from school and delivering home works. The sheet says plainly that it
changes your default, because it does.

The refinement is to make it a genuine per-order field so the default is left
alone. `place_order` already accepts `dropoff_lat`, `dropoff_lng`,
`dropoff_text`; the merchant order routes never forward them. Same one-line
shape as §3, and the client change afterwards is small.

---

## 5. 🟠 H10 — Arrival detection

Nothing notices a rider reached the merchant or the door — every transition is
a manual tap, so `arrived_at_merchant` is only as accurate as a busy rider's
memory.

Rider telemetry lands in `rider_locations` (lat, lng, `order_id`,
`recorded_at`) continuously while on duty, so the data to do this server-side
already exists: geofence the merchant's `lat`/`lng` and the order's
`dropoff_lat`/`dropoff_lng`, and either auto-advance or prompt.

Note the client now **queues** fixes through a dead zone and drains them on
reconnect, so a burst of backdated-looking fixes on one `order_id` is normal
and not a spoof. Timestamps are server-side; the client never supplies one.

---

## 6. 🟠 H17 — Nothing times out a stuck order

An order nobody claims sits forever: no timeout, no escalation, no notice to
the customer, and the merchant has already cooked.

Half of this is now fixed on the ops side — the admin console surfaces orders
whose `updated_at` has not moved in 45 minutes, and an admin can re-list or
cancel them. But that only works if a human is looking.

The server half: watch for non-terminal orders going quiet and either notify
the customer, escalate to admins, or auto-cancel past some threshold. The
primitives exist and are tested:

```sql
admin_unassign_order(order_id uuid, reason text)  -- back to the rider feed
admin_cancel_order(order_id uuid, reason text)    -- ends it, canceled_by='admin'
```

`admin_cancel_order` refuses a **delivered** order on purpose: wallet rows are
written at `delivered` only, so cancelling before then has no ledger
consequence, and cancelling after would strand a payout and a COD debit with no
reversing entry in an append-only ledger. The customer app already renders
`canceled_by = 'admin'` as "Canceled by Cartman" with the reason.

---

## 7. 🟡 I8 — Retest address search

BUG-001 was logged before the Mapbox keys were in place. `GET /geo/search` and
`/geo/reverse` should now work. Retest and close or re-log.

**Contract reminder:** geocoding must **fail soft on both sides**. Any upstream
error, timeout, or missing token resolves to empty results — never a thrown
error, never a 5xx. A customer who cannot save an address cannot order at all,
so a degraded geocoder falls back to typing plus a manual pin.

---

## Database contracts you can rely on

All applied to CartmanPH and covered by tests. None of these need changing.

| RPC | Who | What |
|---|---|---|
| `place_order(jsonb)` | customer | Now reads `dropoff_instruction` / `dropoff_note` |
| `rider_release_order(order, reason)` | rider | Hand back pre-pickup only; refuses once carrying |
| `admin_unassign_order` / `admin_cancel_order` | admin | The stuck-order overrides |
| `admin_set_rider_verified` / `admin_set_merchant_verified` | admin | The two gates; both log to `verification_events` |
| `admin_set_incident_status` | admin | Triage for `incident_reports` |
| `delete_my_account` / `account_deletion_blockers` | customer | §2 |
| `rider_submit_pod(order, photo, note)` | rider | POD write path — `orders` has no UPDATE policy, so this RPC is the only way |

**Two things worth knowing before writing any migration or grant here:**

1. **A grant is not a policy and a policy is not a grant.** POD columns were
   granted to `authenticated` with no matching UPDATE policy on `orders`, so
   the write matched zero rows and *reported success*. It failed upward.
2. **A narrow grant is not evidence of a narrow grant.** Supabase's default
   privileges give `all` on every table a migration creates, so
   `grant select, insert on <table>` narrows nothing. Only a preceding
   `revoke` does. This is how a rider could run
   `update riders set is_verified = true where id = auth.uid()` from the anon
   key and defeat the whole verification gate — fixed 2026-08-06, but the shape
   recurs.

---

## Not server work, but still open

- **Promote an admin account** — `update profiles set role = 'admin' where id
  = '<uuid>'`. Without one, the admin console is unreachable and both
  verification gates stay SQL-operated.
- **Merchant panel redeploy** — it was a file-tree upload, so pushing to `main`
  does not ship it. The admin console is in the repo and not yet live.
- **Android keystores** — without them release APKs are debug-signed: fine for
  a tester, not uploadable to Play.
- **`melos bootstrap && melos run analyze`** before building. `image_picker` is
  a new native dependency, and a batch of Dart was written this week without a
  compiler available — see `docs/HANDOFF.md` §1 for the files ranked by risk.
