# Cartman — what's left, and it's all cartman-server

**For the cartman-server monorepo session.** Written to be self-contained: it
assumes no knowledge of `cartman-mobile` and states every contract it depends
on. Everything here is the remaining work before APKs go to a tester.

**Refreshed 2026-08-13** from `cartman-mobile@fe15a81` (`docs/server-handoff.md`),
and re-verified against *this* repo's `main` rather than copied — three claims
in the mobile copy were stale here and are corrected inline, each marked
**Verified in this repo 08-13**.

**Status elsewhere.** The database is done and applied to **CartmanPH**
(`jxyromcmejhmhkgpydmy`) — 153 tests green, every migration applied and
recorded through `20260810000200` (the push outbox). The merchant panel is done — 79
tests green, tsc clean. Both mobile apps are feature-complete against every
spec: `flutter analyze` clean, **402 Flutter tests green** (core 246 ·
customer 107 · rider 49).

**Status here.** `npm test` → **436 passed, 42 suites**, build + lint clean
(verified 08-13, after the drainer landed).

**Landed 2026-08-13, all TDD'd and mutation-checked:**

| What | Where | Notes |
|---|---|---|
| **L3 drainer** | `src/push/push-drain.service.ts` | Polls every 10s, posts to `push-send`, stamps `sent_at` / `attempts` / `last_error`. 12 tests |
| `push-send` client | `src/push/push-send.client.ts` | 7 tests |
| **H17 — stuck orders** | `src/push/stuck-order.service.ts` | Every 5 min; notifies customer + admins on orders quiet 15 min. **Changes no order state.** 6 tests |
| **verification_events fix** | `src/admin/admin-verifications.service.ts` | Superseded 2026-08-31 — this service no longer writes the audit row, or flips `is_verified`. `admin_set_rider_verified` does both. See below |
| `push_outbox` model | `prisma/schema.prisma` | Mirrors `20260810000200` exactly |

Ordered by what actually blocks a tester.

---

## 0. BUG-013 — ✅ FIXED 2026-08-10

> **Closed in cartman-server.** The diagnosis below was right about the shape —
> the code was consumed before something that could throw — but not about what
> threw. **`profiles.phone` is `UNIQUE`.** `OtpService.verify` marked the code
> consumed and *then* wrote `phone` onto the profile, so a number another
> account already held raised Prisma `P2002`, which `AllExceptionsFilter`
> rendered as a bare 500 — with the code already spent. The retry's
> `findFirst({consumed: false})` then matched nothing and answered "No valid
> OTP found", inside the code's own validity window.
>
> Fixed: the consume and the profile write are one `$transaction`, and a
> collision answers **409** naming the real problem. The attempts increment
> stays outside the transaction on purpose — otherwise a wrong guess would roll
> back its own counter and `MAX_ATTEMPTS` could never be reached.
>
> **Verified in this repo 08-13:** `src/auth/otp.service.ts` — the
> `$transaction` is at :210, the attempts increment is deliberately outside it
> at :181 with a comment saying why, and the `P2002` → `ConflictException`
> mapping is at :230.
>
> **Why QA hit it every time and a fresh install never would:** a tester has
> one phone number and many test accounts. The first account claims the number;
> every account after it 500s. Any retest must reuse those accounts.
>
> The section below is the original diagnosis, kept because the reasoning is
> what found it. Nothing in it is outstanding.

### Original write-up (superseded)

**Added 2026-08-09. Marked Critical by QA and it is the only item on this page
that stops the app being testable at all.** Cash on Delivery requires an
OTP-verified phone (non-negotiable #7), so a broken verify means no order of
any kind can be placed. The tester's own "Left to Test" list — Ordering,
Pickup & Delivery, Pasakay, Pabili — is explicitly gated on it.

Reported behaviour, in order:

1. Submitting the **correct** code returns an internal server error.
2. Submitting the same code again is rejected as invalid — inside its own
   documented 10-minute validity window.
3. Repeated attempts eventually return **429**.

Steps 1 and 2 are the actual defect and both are server-side. The shapes worth
checking first, given "correct code → 500 → then invalid":

- **The verify consumes or invalidates the code before it can fail.** If the
  row is marked used (or deleted) and *then* something downstream throws, the
  500 leaves the customer holding a code the database has already spent. That
  matches the reported order exactly. Consume the code only after everything
  that can throw has succeeded, in one transaction.
- **The 500 itself.** Whatever it is, it is being reached on the happy path,
  so it is not validation — look at what runs after the code matches
  (profile update, `phone_verified` write, Semaphore callback).
- **The 429 is a symptom, not a cause.** It is the rate limiter counting the
  retries the first two problems forced.

**What the client already does, so don't re-fix it here.** As of
`packages/core/.../api/cartman_api_client.dart` on 2026-08-09, a 429 or 5xx no
longer clears the entered code — neither says the code was wrong — and the
error text shown to the customer is ours, not Dio's. (The app was rendering
Dio's own `RequestOptions.validateStatus` paragraph verbatim, complete with a
wrong definition of 429. That is fixed and tested; it was never a server bug,
only a server error made visible.) So the server can return a bare 429 with no
body and the customer still sees "Too many attempts. Please wait a minute and
try again."

**One request:** send a JSON `message` on 4xx/5xx where you can. Both clients
prefer it over their own fallback, and a specific "That code has expired" beats
a generic one every time. The merchant panel does the same
(`apps/merchant-web/src/lib/errors.ts` in cartman-mobile).

### Contract the client expects

```
POST /auth/send-otp    { phone }            → { code? }   // code only in dev mode
POST /auth/verify-otp  { phone, code }      → { verified: boolean }
```

Both with `Authorization: Bearer <supabase access token>`. Source of truth on
the client: `packages/core/lib/src/data/supabase_auth_repository.dart`.

---

## Status in this repo — updated 2026-08-13

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

### Schema drift — the mirror is reconciled, and `db push` is off the deploy path

> **This section used to say drift was "mostly closed, verified 08-13" and name
> two remaining gaps. That was written a week before the incident below, and it
> was stale inside the very PR that fixed it. Rewritten 2026-08-24.**

**What happened.** On 2026-08-20 four objects were found missing from CartmanPH
while their migrations were still recorded as applied: `merchants.busy_until`,
`push_outbox`, `order_messages`, and the policies + grants on
`incident_reports` / `verification_events`. Two were live outages —
`place_order` raised *"column m.busy_until does not exist"* on every food and
grocery order, and the `orders` push triggers raised on every insert and status
update, because the triggers survived and their table did not.

**What caused it.** Not a person. `render.yaml` carried
`preDeployCommand: npx prisma db push --accept-data-loss` next to
`autoDeployTrigger: commit`, so **every push to the deployed branch re-ran it
against production.** `db push` drops what `schema.prisma` does not mention and
writes no `_prisma_migrations` row — objects gone, migrations still recorded,
no trace.

**What this branch does about it.**

| | |
|---|---|
| `db push` | Removed from `render.yaml`. The deploy touches no DDL at all |
| The mirror | `order_messages` and `push_outbox` both modelled — 21 → 23 models, so the two gaps this section used to list are closed |
| The guard | `npm run db:drift` — read-only, diffs `schema.prisma` against a live database, exits non-zero on any difference and names which direction each runs. Run it after every migration applied in cartman-mobile |

**Reconciling the mirror is necessary but not sufficient, which is why the ban
is absolute rather than "keep it in sync and it's fine".** Prisma cannot express
`menu_items.search_tsv` (generated stored), its GIN index, `push_outbox`'s
partial index, or the `rider_wallet_balance` view — `db push` would damage the
schema even with a perfect mirror.

**And `db:drift` cannot see the class the incident's fourth item belongs to.**
It compares tables, columns and enums; policies, grants, triggers, functions and
indexes are outside what Prisma models. A green run means `db push` would not
drop a table or a column — it is not a statement about who can read what.
`supabase/migrations/` in cartman-mobile stays the only authority there.

> **One item from the 08-20 write-up is now closed, contrary to what
> cartman-mobile's copy still said.** That doc carried *"CartmanPH still has the
> wider grant — the corrected `20260820000100` needs re-running against it."*
> **Checked live 2026-08-24: it does not.** `authenticated` holds INSERT on
> `order_messages(order_id, sender_id, body)` only, with no table-wide INSERT,
> so a client cannot supply `created_at` and backdate a message. Nothing to
> re-run. The mobile doc has been corrected.

Adding a column here changes what Prisma SELECTs and therefore what the API
returns, so each addition stays a deliberate call rather than a tidy-up. Note
`incident_reports` (cartman-mobile H11) and this repo's own `incidents` table
are still two different systems — see "Product decisions" at the bottom.

**`delivery_failed` is merged and applied.** An earlier ops list said the
catch-up branch must not merge before `20260809000100_delivery_failed.sql` was
applied. Both happened: the migration is applied to CartmanPH, and the server
half is on `main` (`src/orders/orders.service.ts`, `src/admin/admin.service.ts`,
`schema.prisma`). Nothing outstanding — ignore that warning if you meet it
again in cartman-mobile's `docs/backend-ops-tasks.md`.

**§2 (L5) is done.** `AccountSweepService` (`src/accounts/`) runs hourly via
`@nestjs/schedule` (`@Cron(CronExpression.EVERY_HOUR)`), deletes the
`auth.users` row behind every tombstoned profile, and stamps
`profiles.auth_deleted_at`.

The sweep this doc originally sketched would not have terminated. **`profiles`
has no foreign key to `auth.users`** — verified against the live database — so
deleting the auth row leaves the tombstone standing, and
`select id from profiles where deleted_at is not null` keeps returning the same
accounts forever. Nor can the tombstone be removed: `orders.customer_id`
references it `ON DELETE RESTRICT`, deliberately, because those rows are the
merchant's books. So it needed a marker of its own —
`20260807000100_account_deletion_sweep.sql`, applied and verified on
CartmanPH. `auth_deleted_at` is stamped only *after* the delete is confirmed,
so a crash between the two retries rather than stranding live credentials, and
an already-absent user counts as swept rather than as an hourly error forever.

**Nobody has watched it run against a real tombstoned account.** That is the
half app-store review checks, and it is §5 of `ops-credentials-runbook.md`.

**§1 (L3) — the transport is done; the drainer is not.** `push-send` now
does real FCM HTTP v1: service-account JWT (RS256) → OAuth2 token, cached until
60s before expiry → `messages:send` per token, plus pruning of tokens FCM
reports as `UNREGISTERED` / `INVALID_ARGUMENT`, and only those (a 5xx or a
quota error is retryable, and pruning on it would silently unsubscribe a
working device). With any credential missing it still answers 200 with
`sent: 0` and a preview, so callers can be wired before the creds exist.
The crypto is covered by `supabase/functions/_shared/fcm.test.ts` — 7 Deno
tests, no Firebase account needed; it generates a throwaway RSA key and
verifies the assertion against its own public half.

**§1 (L3) update, 08-11 — the decision half now exists; only the drainer is
left.** `20260810000200_push_outbox.sql` adds a `push_outbox` table and six
triggers that cover every row of §1's table below except the rider broadcast
feed. 13 tests in `supabase/tests/push_outbox.test.ts`.

It is an **outbox**, not `net.http_post` from the trigger, for four reasons
spelled out in the migration header: an order transition must not depend on a
notification succeeding; `pg_net` is not enabled on CartmanPH and enabling it
would break the PGlite suite that applies every migration; no service-role key
has to enter the database (a key in a migration is a key in git); and a failed
send stays visible in `attempts` / `last_error` instead of vanishing.

This also settles the note that used to sit here about approval events needing
a DB trigger because they bypass cartman-server: they do bypass it, and they
are now handled in the database — but as an outbox row, so the *sending* still
happens in one place.

**✅ The drainer landed 2026-08-13** — `src/push/`. See §1.

Still open here: §5 (H10 — arrival detection), §7 (I8 — retest address
search). §6 (H17) has its notification half; escalation and auto-cancel were
deliberately not built (see §6).

---

## 1. 🔴 L3 — Push notifications

**Nobody is told anything**, which now costs more than it used to because three
features added this week depend on a notification to close their loop. Two of
the three pieces are now built; read the 08-11 update above for the shape.

### Needs
- ~~Real send in `push-send`~~ — ✅ real FCM HTTP v1, 7 Deno tests.
- ~~Something that decides who to notify~~ — ✅ `push_outbox` + six triggers,
  13 tests. Applied to CartmanPH 08-11.
- ~~A drainer~~ — ✅ **landed 08-13**, `src/push/push-drain.service.ts`.
  Polls every 10s, oldest-first, batches of 50, `attempts < 5`. Stamps
  `sent_at` on a 2xx; bumps `attempts` and writes `last_error` otherwise.
  Overlapping passes are guarded — the poll is far shorter than 50 HTTP sends
  can take, and a second pass would re-send every unstamped row.
  **A 200 with `sent: 0` counts as success on purpose:** that is what
  `push-send` answers until the Firebase credentials exist, and retrying it
  would push every row past the attempt ceiling, so nothing would drain on the
  day the creds finally land.
- Firebase service account → `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`,
  `FCM_PRIVATE_KEY` as **Supabase Edge Function secrets, not Render** —
  `push-send` reads them through `Deno.env`. Console walkthrough:
  `ops-credentials-runbook.md` §3. Until these exist `push-send` answers 200
  with `sent: 0`, so the drainer can be built and verified end to end first —
  rows will be stamped sent and simply not delivered.
- `google-services.json` / `GoogleService-Info.plist` into the two apps —
  git-ignored by design, so they are handed over out of band.

### Building the drainer

Read:

```sql
select id, user_id, title, body, data from public.push_outbox
 where sent_at is null and attempts < 5 order by created_at limit 50;
```

POST each to `push-send` with the service-role key this codebase already holds,
then stamp `sent_at` on success or bump `attempts` and set `last_error` on
failure. A poll every few seconds is fine; the table is indexed for exactly
this query (partial, `where sent_at is null`). Doing it here is preferred over
pg_cron + pg_net precisely because the key lives here already. The migration is
**already applied to CartmanPH and recorded** (08-11) and verified live — 5
triggers, RLS on with 0 policies, and no grant or EXECUTE for anon or
authenticated — so the table is there to read from now.

Both prerequisites are handled: the `push_outbox` model is now in
`schema.prisma` (mirroring `20260810000200` exactly), and the drainer runs on
this server's own Prisma connection — which is the service-role path, not the
request-scoped one. That mattered: RLS is on with **zero policies** and all
privileges revoked from `anon`/`authenticated`, so an anon-scoped read would
have returned zero rows and reported success, the same "failed upward" shape as
the POD grant below.

### ⚠️ It cannot deliver anything yet, and that is not this repo's fault

`device_tokens` is **empty on CartmanPH — 0 rows, verified 08-13** — because
neither mobile app declares `firebase_messaging` and nothing calls
`DeviceTokenRepository.register()`. The drainer will happily drain the queue
into `push-send`, which will answer `sent: 0, targeted: 0` and mean it. **Both
the Firebase credentials and the client FCM wiring are still required before a
phone buzzes.** See the corrected device-token section above.

`push_outbox` was also empty at 0 rows on 08-13 — explained by zero activity,
not by broken triggers: no orders and no merchants have been created since the
migration was applied on 08-11 (the 2 push triggers on `orders` are installed
and present). The first live order is what will prove the loop end to end.

### ⚠️ Device tokens do **not** work yet — corrected 2026-08-13

**Earlier versions of this doc said "the `device_tokens` table is populated,
nothing on the client side is missing." That is wrong, and it is the kind of
wrong that wastes a day.** Verified in `cartman-mobile@fe15a81`:

- **Neither app declares `firebase_messaging`** — no `firebase_messaging` or
  `firebase_core` in `apps/customer/pubspec.yaml`, `apps/rider/pubspec.yaml`,
  or `packages/core/pubspec.yaml`. Without the SDK the app can never *obtain*
  an FCM token.
- **Nothing calls `DeviceTokenRepository.register()`.** The class exists
  (`packages/core/lib/src/data/device_token_repository.dart`) and is exposed as
  `deviceTokenRepositoryProvider`, but the provider definition is its only
  reference in either app. Its own doc comment says as much: FCM wiring "is a
  deploy-time step the team does once Firebase project credentials exist."

So `device_tokens` is **empty and will stay empty**. The server side is
genuinely finished — the endpoints exist, `device_tokens` is in
`schema.prisma`, and the upsert is on `(user_id, token)` so repeat calls are
safe. But a completed drainer plus valid FCM credentials would still deliver
**zero** notifications, because there is no token to send to.

**L3 is therefore three pieces, not one:** the drainer (here), the credentials
(ops), and **client FCM wiring** (cartman-mobile — add the package, drop in
`google-services.json`, call `register()` after sign-in and on token refresh,
`unregister()` on sign-out). The third is not tracked anywhere else; raise it
rather than assuming someone has it.

**None of this blocks building the drainer.** Insert a row into `push_outbox`
and a fake `device_tokens` row by hand and the whole loop is testable today.

### What to send, and to whom
Everything marked ✅ is already decided by a trigger and lands in `push_outbox`
under the `event` shown; the drainer only has to deliver it.

| Event | Who hears | Queued as | Why it matters |
|---|---|---|---|
| Order placed | merchant | ✅ `order.placed` | The panel chimes only while a tab is open |
| Order accepted / ready / picked up / arriving / delivered / canceled | customer | ✅ `order.preparing` … `order.canceled` | The whole tracking loop is silent otherwise |
| Rider claimed the order | merchant | ✅ `order.claimed` | Fires on `assigned_rider_id`, not on a status change — the status often does not move |
| New order on the feed | on-duty riders | ❌ **not queued** | The only gap left. A broadcast is a different shape: it fans out to every on-duty rider in range and goes stale the moment someone claims, so a per-user outbox row is the wrong tool. Needs a decision, not just wiring |
| **Rider approved** (H16) | that rider | ✅ `rider.approved` | They are shown "we're reviewing your account" and have no way to learn it changed except reopening the app |
| **Store approved** | that owner | ✅ `merchant.approved` | Same shape — the panel says "awaiting approval" and never updates |
| **A merchant signed up** | admins | ✅ `merchant.awaiting_review` | Nothing tells anyone a store is waiting; approvals are pull-only today |

The last three are new. They exist because the verification gates went live
this week and both default to false.

**This unblocks H16** — a rider is told they are under review and then has no
way to learn they were approved except by reopening the app. The
`rider.approved` row is queued the moment `is_verified` flips; it just is not
delivered yet.

**Worth reconciling while you are in here:** confirm which Edge Functions are
actually deployed to `jxyromcmejhmhkgpydmy`. The mobile repo carries
`otp-send`, `otp-verify`, `push-send` and `fare-calc`, but the live OTP path is
**this server's `POST /auth/send-otp`**, not an Edge Function — so at least two
of those four are probably dead code that will confuse the next person.

---

## 2. 🔴 L5 — The account-deletion sweep — ✅ SHIPPED, unverified live

**This is the half an app-store reviewer actually checks.** Apple 5.1.1(v) and
Google Play both require in-app account deletion, and the app has it — the
deletion is not final without this, and this now exists (see the status section
above). What is left is one deliberate end-to-end run against a real tombstoned
account: `ops-credentials-runbook.md` §5 has the six steps and the queries.

### What already happens
`delete_my_account()` (RPC, shipped and applied) tombstones the profile:
name → `Deleted user`, phone → null, avatar → null, `deleted_at` set. Saved
addresses are erased. Store membership is dropped and a store left with no
members is closed. A rider is taken off duty and un-verified.

Orders deliberately **survive** — `orders.customer_id` has no `ON DELETE`, and
those rows are the merchant's sales history and the rider's ledger. PH
record-keeping outranks the erasure request; RA 10173's right to erasure is
explicitly subordinate to records required by law.

### The evidence query, if it is ever suspected of being down

```sql
select id, deleted_at from public.profiles
 where deleted_at is not null and auth_deleted_at is null;
```

Rows here are accounts the user asked to delete and whose logins still work.
That list should drain to empty within an hour of each deletion; if it grows,
the job is down.

### Blockers already enforced (do not duplicate)
`account_deletion_blockers()` refuses deletion for: a live order, an unsettled
rider wallet (they hold COD cash or are owed a payout — the ledger is
append-only), or being the sole member of a trading store. The app asks before
offering the button. The RPC re-checks anyway.

---

## 3. 🟠 I3b — Order routes drop the drop-off instruction — ✅ DONE

Kept for the contract, not as a task. The customer can choose **hand to me /
leave at the door / meet at the gate / meet outside** plus a free-text note,
and the rider's active screen shows it prominently.

`orders.dropoff_instruction` is an enum
(`hand_to_me | leave_at_door | meet_at_gate | meet_outside`, default
`hand_to_me`) and `orders.dropoff_note` is text. Omitting the keys still yields
`hand_to_me`, so nothing changes for callers that do not send them.

### ⚠️ Still true, and still a live hazard for the DTO
The client **sends both fields optimistically**, and retries once without them
if the server answers 400. That was deliberate: if the `ValidationPipe` uses
`forbidNonWhitelisted`, an unknown property 400s the whole request and **every
food order breaks**. What you must *not* do is add strict rejection of unknown
fields without first checking every optimistic field the clients send.

---

## 4. 🟠 I2 — Per-order drop-off — ✅ DONE

Deliver-elsewhere used to work by a side door: checkout promoted the chosen
address to **default**, and the server resolved the drop-off from the default.
It is now a genuine per-order field, so the default is left alone.

---

## 5. 🟠 H10 — Arrival detection

Nothing notices a rider reached the merchant or the door — every transition is
a manual tap, so `arrived_at_merchant` is only as accurate as a busy rider's
memory.

What that costs today:
- The merchant has no signal the rider is outside, so the food sits under a
  heat lamp or the rider waits.
- The customer's tracking screen goes quiet between `picked_up` and
  `delivered` — the longest stretch of the order, and the one they care about.
- A rider who forgets to tap leaves the order looking stuck, which is what
  §6's queue then has to clean up.

Rider telemetry lands in `rider_locations` (lat, lng, `order_id`,
`recorded_at`) continuously while on duty, so the data to do this server-side
already exists: geofence the merchant's `lat`/`lng` and the order's
`dropoff_lat`/`dropoff_lng`, and either auto-advance or prompt.

Note the client now **queues** fixes through a dead zone and drains them on
reconnect, so a burst of backdated-looking fixes on one `order_id` is normal
and not a spoof. Timestamps are server-side; the client never supplies one.

**Decide before building:** what radius counts as arrived (dense barangay vs
highway), whether an arrival is a new order status or a separate timestamp
column (a new status means touching every `switch` over `OrderStatus` in both
apps), and whether it auto-advances or only notifies. **A notification-only
version is much cheaper and gets most of the value** — the outbox from §1 is
already there to carry it.

---

## 6. 🟠 H17 — Nothing times out a stuck order — notification half ✅ 08-13

`StuckOrderService` (`src/push/stuck-order.service.ts`) runs every 5 minutes,
finds non-terminal orders whose `updated_at` has not moved in **15 minutes**,
and writes `push_outbox` rows: `order.stuck` to the customer, and
`order.stuck.admin` to every admin. 6 tests.

**It changes no order state, deliberately.** Auto-cancelling an order a
merchant has already cooked is a worse failure than a slow one, and wallet rows
are written at `delivered`, so a cancel carries ledger consequences a
notification does not. A human still decides; this only makes sure a human —
and the customer — knows.

Two details worth keeping:

- **De-duplication reads `push_outbox` itself** rather than a new
  `stuck_notified_at` column, so it needed no migration. Migrations live in the
  other repo and are applied by hand, which makes "no migration" a real
  feature here.
- **The status filter is a deny-list** (`notIn: TERMINAL_ORDER_STATUSES`), so a
  newly added status joins "live" by default instead of silently escaping the
  sweep. This repo shipped the inverse bug once already: three guards spelled
  the terminal set as `notIn: [delivered, canceled]`, and `delivery_failed`
  escaped it to count as an *active* order everywhere.

### Still open on H17

- **No escalation.** Nothing widens the dispatch radius or raises the rider
  payout. That needs a payout-override column and feed-ranking changes.
- **No auto-cancel.** Left out on purpose (above). The primitives are there if
  the policy is ever decided:

```sql
admin_unassign_order(order_id uuid, reason text)  -- back to the rider feed
admin_cancel_order(order_id uuid, reason text)    -- ends it, canceled_by='admin'
```

`admin_cancel_order` refuses a **delivered** order on purpose: cancelling
before `delivered` has no ledger consequence, and cancelling after would strand
a payout and a COD debit with no reversing entry in an append-only ledger. The
customer app already renders `canceled_by = 'admin'` as "Canceled by Cartman"
with the reason.

**Note the two thresholds do not match.** The admin console flags an order at
**45 minutes**; this job notifies at **15**. That is intentional — a customer
should hear from us long before an order is old enough to be a console item —
but if one moves, decide about the other rather than letting them drift.

The primitives exist and are tested:

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

## 7. 🟡 I8 — Retest address search — token is set; retest and close

**Updated 08-11: `MAPBOX_TOKEN` is set and address search is working.** The
report from the field is now that it is *slow*, not empty — which it could not
be without a token. So **BUG-001, ENH-009 and ENH-010 are almost certainly
closeable**; they need a tester to confirm, not code.

Two things came out of it that are still open:

- **The billing alert is not set**, and the token is metered and serving real
  traffic today. cartman-mobile's `CLAUDE.md` §3.1 made the alert a
  precondition of using Mapbox at all. It is §2 of
  `ops-credentials-runbook.md`.
- **First-search latency is this repo's.** The client shipped a session cache,
  request de-duplication, instant paint on a cache hit and a 6s type-ahead cap
  (08-11), which helps repeats only. A cold query is a round trip to here and
  out to Mapbox, plus a cold Render instance if it has been idle. **Check the
  server-side `GeoCache` is actually being hit before assuming Mapbox is the
  slow part.**

**Contract reminder:** geocoding must **fail soft on both sides**. Any upstream
error, timeout, or missing token resolves to empty results — never a thrown
error, never a 5xx. A customer who cannot save an address cannot order at all,
so a degraded geocoder falls back to typing plus a manual pin.

---

## Database contracts you can rely on

All applied to CartmanPH and covered by tests. None of these need changing.

| RPC | Who | What |
|---|---|---|
| `place_order(jsonb)` | customer | Reads `dropoff_instruction` / `dropoff_note`. **This server does not call it** — see the correction above |
| `rider_release_order(order, reason)` | rider | Hand back pre-pickup only; refuses once carrying |
| `rider_report_delivery_failed(order, reason, note)` | rider | Writes **no** wallet entry, deliberately — a failed attempt is not a delivery |
| `admin_unassign_order` / `admin_cancel_order` | admin | The stuck-order overrides |
| `admin_set_rider_verified` / `admin_set_merchant_verified` | admin | The two gates; both log to `verification_events`. Called by the panel **directly over Supabase**. **Not callable from here** — see below |
| `admin_set_incident_status` | admin | Triage for `incident_reports` |
| `delete_my_account` / `account_deletion_blockers` | customer | §2 |
| `rider_submit_pod(order, photo, note)` | rider | POD write path — `orders` has no UPDATE policy, so this RPC is the only way |

### ⚠️ The admin RPCs cannot be called from this server — found 08-13

`admin_set_rider_verified` opens with `v_uid uuid := auth.uid()`, raises
`not authenticated` when that is null, and stamps `actor_id = v_uid`.
**`auth.uid()` is always null on this server's Prisma connection** — it is set
by PostgREST from a user's JWT, and nothing sets it here. So "just call the
RPC" is not available to any code path in this repo; it is available to the
merchant panel, which talks to Supabase directly with the admin's session.

That is why the gate had no audit trail. `AdminVerificationsService.approve()`
flipped `riders.is_verified` directly through Prisma, so nothing wrote
`verification_events` — **5 verified riders, 0 audit rows on CartmanPH,
verified 08-13.** Fixed the same day: the route now takes the admin from
`@CurrentUser()` and writes the audit row inside the existing transaction,
guarded on the rider `updateMany` actually matching (the `verifications` queue
also carries merchant permits, where that update is a deliberate no-op).

**H16's push was never affected by this** — `push_on_rider_verified` is a table
trigger (`after update of is_verified on riders`), so a direct Prisma write
fires it too. Only the audit was missing, not the notification.

> **Superseded 2026-08-31.** The two paragraphs above describe a fix that has
> since been removed, and are kept because the incident they record is still
> the reason the current design looks the way it does. `AdminVerificationsService`
> no longer writes `verification_events` and no longer flips `riders.is_verified`
> — it only sets the `verifications` row's status, which now carries merchant
> permits alone. Rider approval moved to `admin_set_rider_verified`, which
> stamps the flag, the `rider_documents` rows the rider actually uploaded, and
> the audit row together, from `auth.uid()`. Two writers to one flag is what
> produced the 5-verified-riders/0-audit-rows discrepancy in the first place;
> there is now exactly one.

**Three things worth knowing before writing any migration or grant here:**

1. **A grant is not a policy and a policy is not a grant.** POD columns were
   granted to `authenticated` with no matching UPDATE policy on `orders`, so
   the write matched zero rows and *reported success*. It failed upward. The
   `push_outbox` drainer can fail the same way — see §1.
2. **A narrow grant is not evidence of a narrow grant.** Supabase's default
   privileges give `all` on every table a migration creates, so
   `grant select, insert on <table>` narrows nothing. Only a preceding
   `revoke` does. This is how a rider could run
   `update riders set is_verified = true where id = auth.uid()` from the anon
   key and defeat the whole verification gate — fixed 2026-08-06, but the shape
   recurs.
3. **`revoke execute … from anon` alone is a no-op.** `anon` does not hold
   EXECUTE directly — it inherits it from the default grant to `PUBLIC`, and
   revoking from a role does not touch a privilege held via PUBLIC. It has to
   name PUBLIC. Fixed in `20260810000100`; 0 of 34 public functions are now
   anon-executable.

**After any apply that does not go through `supabase db push`, check what got
recorded.** The Supabase MCP connector records a migration under a version it
*generates*, not the repo filename — `20260810000200` came back as
`20260811155823` and had to be realigned by hand, or `db push` would have
replayed it:

```sql
select version, name from supabase_migrations.schema_migrations
 order by version desc limit 3;
```

---

## Product decisions, not bugs

These need someone to choose, and then they become small.

- **The rider broadcast feed is the one push event deliberately not queued.**
  Is it a broadcast to an FCM **topic** (cheap, no per-rider rows, but no way
  to stop the losers' phones buzzing), or a narrow send to the nearest few
  riders with a short TTL? The claim is already atomic (`accept_order`), so a
  stale notification is a wasted buzz, never a double assignment.
- **`incident_reports` vs `incidents` are two different tables for the same
  idea** — and, as of 08-13, **both are now in this repo's `schema.prisma`**,
  which makes the split easier to trip over, not harder. A rider's incident
  report never reaches the admin console. Someone has to pick the canonical
  one; it is a small migration either way, but it is a choice about which
  system owns safety reports.
- **`delivered_at` may never be stamped** on deliveries completed through this
  server — reported by an earlier session, still unverified against the server
  code. The column *is* in `schema.prisma`; whether anything writes it is the
  open question.
- **The rider broadcast feed** — decided 08-13: an **FCM topic per service
  area**, not per-rider outbox rows. On-duty riders subscribe on duty-on and
  unsubscribe on duty-off; one publish reaches the area. The claim is already
  atomic (`accept_order`), so a stale buzz is wasted, never a double
  assignment. **Not built** — it needs `push-send` to accept a topic target,
  and the subscribe/unsubscribe lives in the rider app, which has no FCM SDK
  yet. Blocked behind the same client wiring as everything else in L3.
- **I9 — rewards, points, vouchers and tiers are mock in both modes.** There is
  no rewards backend and no spec for one. Decide whether rewards are in scope
  for launch at all; if not, the cleanest move is deleting the screens rather
  than shipping plausible-looking fake numbers next to real money.

---

## Not server work, but still open

- **Promote an admin account** — and it is now the single most blocking item on
  the whole project: **no account in production has `role = 'admin'`**, so a
  rider signs up, sees "we're reviewing your account", and nothing can ever
  review it. `ops-credentials-runbook.md` §1. Five minutes.
- **Android keystores** — without them release APKs are debug-signed: fine for
  a tester (who must uninstall before each install), not uploadable to Play.
- **Merchant panel deploy** — not an issue; it is git-connected on its own
  Vercel account, so a push to `main` ships it. Earlier handoffs said
  otherwise and were wrong.

Credential and account tasks are **not** in this file. They are in
`ops-credentials-runbook.md`, written step-by-step for whoever holds the
Firebase / Play / Render / Supabase logins.
