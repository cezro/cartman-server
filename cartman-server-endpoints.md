# cartman-server — endpoint contract & the missing routes

Build-ready spec for the **cartman-server** repo (`cezro/cartman-server`,
NestJS + Prisma). Derived from exactly what the mobile apps
(`packages/core/lib/src/data/*`, `.../api/cartman_api_client.dart`) and the
Merchant Panel (`apps/merchant-web/src/lib/api.ts`) already call. cartman-server
lives in a **separate repo**, so this doc is the cross-repo contract; it sits
next to `backend-schema.md` (the DB contract) on purpose.

> **Why this exists:** order/dispatch/ledger **writes** go through cartman-server
> (Bearer = the Supabase session access token); **reads + Realtime** stay
> direct-to-Supabase under RLS. See `docs/INTEGRATION.md` and
> `docs/dev-runbook.md`. The DB already ships `security definer` RPCs that are
> the *DB-level equivalents* of these routes (`supabase/migrations`,
> exercised by `supabase/tests`) — a route's job is usually: verify the JWT →
> set the request-scoped Postgres identity → call the matching RPC → return its
> JSON. Where an RPC already exists, **call it** instead of hand-writing the
> UPDATE, so the atomicity/RLS guarantees in `CLAUDE.md §3` hold in one place.

> **Status — as-built:** all seven gaps below are now implemented in
> cartman-server. One structural deviation from the guidance above: this
> server's established pattern is direct Prisma writes inside transactions
> (it holds its own DB connection; it does not call the Supabase RPCs), so
> each route **matches the RPC's semantics** — same guards, same refusals,
> same JSON — rather than invoking it. Each section carries a **Built:**
> line recording exactly what shipped and where it deviates from the
> original sketch.
>
> **Client flips — done (2026-07-18):** the mobile multi-stop arm now POSTs
> `/orders/multi-stop` (UnsupportedError stub deleted, builder screen live),
> the panel reject goes through `PATCH /orders/:id/reject`, courier drafts
> carry `recipient_name`/`recipient_phone` (C-6.3 write side), and the
> `cancel_order` DB-parity RPC ships in `supabase/migrations/`
> `20260717000100_cancel_order.sql`. The rider-feed dispatch rule has a
> cross-service proof spec (`dispatch-feed.integration.spec.ts`).

---

## Auth model (every route below unless noted)

- **Bearer JWT** = the Supabase session `access_token`. Verify with
  `SUPABASE_JWT_SECRET` (HS256). Reject missing/expired/invalid with **401**
  (`CartmanApiUnauthorizedException` on the client keys off exactly this).
- The authenticated user id is the source of truth for ownership — **ignore any
  id in the body/query** for scoping (`riderId`, `customer_id`, etc. are passed
  by clients only for interface parity and must not be trusted).
- Error bodies are `{ "message": string | string[] }`. Nest's default
  validation shape (`string[]`) is already handled by both clients.
- To make RLS-scoped RPCs enforce the *caller's* identity (not the service
  role), the request must run as the user. Either (a) create a per-request
  Postgres client with the user's JWT (PostgREST-style), or (b) call the RPC
  with the service role but pass `auth.uid()` explicitly / `set local
  request.jwt.claims`. Today's RPCs read `auth.uid()`, so option (a) or a
  `set local role authenticated; set local request.jwt.claim.sub = <uid>` wrap
  is required — **do not** bypass the membership/ownership checks by running
  them as service role with no identity set.

---

## Endpoint inventory — what the clients already call

Confirm each of these exists and matches. Money is **integer centavos**
(bigint); some responses stringify bigint — clients accept number *or* numeric
string for `balance`, `cart_points`, `wallet_centavos`.

| Method & path | Caller | Body → Response |
|---|---|---|
| `POST /auth/send-otp` | customer | `{phone}` → `{}` (429 rate-limit, 502 SMS fail) |
| `POST /auth/verify-otp` | customer | `{phone, code}` → `{verified: bool}`; on true, sets `profiles.phone_verified` |
| `GET /auth/me` | both apps | → `profiles` row + nested `rider` relation |
| `POST /orders/food` | customer | `{merchant_id, items:[{menu_item_id, qty}]}` → order JSON |
| `POST /orders/grocery` | customer | `{merchant_id, items:[…]}` → order JSON |
| `POST /orders/errand` | customer | `{errand_payload, notes}` → order JSON |
| `POST /orders/courier` | customer | pickup/dropoff body (below) → order JSON |
| `POST /orders/ride` | customer | pickup/dropoff body (below) → order JSON |
| `POST /orders/multi-stop` | customer | `{stops:[…], notes?, payment?}` → order JSON, **201**. Done — see §1 |
| `GET /orders/history` | customer | → `[order JSON]`, caller's orders, newest-first |
| `PATCH /orders/:id/cancel` | customer | `{reason?}` → order JSON. Sets `canceled_by='customer'` (§4); 404 not-yours, 409 too-late |
| `PATCH /orders/:id/accept` | merchant panel | → order JSON (`pending → preparing`, else 409). Membership-guarded (§3) |
| `PATCH /orders/:id/ready` | merchant panel | → order JSON (`preparing → ready_for_pickup`, else 409). Membership-guarded (§3) |
| `PATCH /orders/:id/reject` | merchant panel | `{reason?}` → order JSON (`pending\|preparing → canceled`); 409 once a rider is assigned. Done — see §2 |
| `GET /orders/feed` | rider | → `[{order: <order JSON>, score, distance_km, expires_at}]`; 403 when off-duty / locked-out (client shows `message`). `expires_at` = `created_at + FEED_ACCEPT_WINDOW_MINUTES` (default 5) — R-4.1 display urgency only, expired entries stay claimable. Entries embed `order_items` + `order_stops` |
| `PATCH /orders/:id/claim` | rider | → `{queued?: bool}`; atomic first-writer-wins (`accept_order` RPC). Response embeds `order_items` + `order_stops` (boots the active screen) |
| `PATCH /orders/:id/status` | rider | `{status}` → order JSON (`advance_order_status` RPC) |
| `GET /riders/me/history` | rider | → `[order JSON]`, delivered, caller-scoped |
| `PATCH /riders/me/duty` | rider | `{is_active: bool}` → `{}` (`set_duty` RPC) |
| `GET /ledger/me/wallet` | rider | → `{balance: string}` (centavos; `rider_net_cash`) |
| `GET /ledger/me/earnings-today` | rider | → `{earnings_today: number}` (centavos) |
| `GET /ledger/me/transactions` | rider | → `[wallet txn]` |
| `POST /profiles/me/addresses` | customer | `{label, text_address, lat, lng, is_default}` → address JSON |
| `PUT /profiles/me/addresses/:id` | customer | partial of the above → address JSON |
| `DELETE /profiles/me/addresses/:id` | customer | → 2xx |
| `POST /profiles/me/device-tokens` | both apps | `{token, platform}` → 2xx (JWT-guarded) |
| `DELETE /profiles/me/device-tokens/:token` | both apps | → 2xx |
| `POST /storage/upload` | customer | multipart `file` + `path` field → `{publicUrl}`. Customer/rider self-scoped (§5) |

**Order JSON shape** (must match `order_as_json` in
`supabase/migrations/20260630000200_functions.sql` so `Order.fromMap` parses it):
`id, ref_no, customer_id, assigned_rider_id, type, status, merchant_id,
merchant_name, payment, pickup_text, dropoff_text, notes, subtotal,
delivery_fee, discount, total, delivery_payout, created_at, items[], stops[]`.

**pickup/dropoff body** (courier + ride):
`{pickup_lat, pickup_lng, pickup_text, dropoff_lat, dropoff_lng, dropoff_text,
notes}`.

---

## The 7 missing / incomplete routes

Ranked by what blocks going live (mirrors `docs/go-live-gaps.md`).

### 1. `POST /orders/multi-stop` (INT-8) — **done**

> **Built:** `OrdersController.placeMultiStopOrder` → `OrdersService.placeMultiStopOrder`
> (`PlaceMultiStopOrderDto`: ≥2 stops, `kind ∈ {pickup, buy, deliver}` —
> matching the DB contract for `order_stops.kind`; 'buy' is the Builder's
> Pabili task tile — seq contiguity checked in the service). Two deviations
> from the sketch below:
> the order is born **`ready_for_pickup`**, not `pending` — this server's
> rider feed only surfaces `ready_for_pickup`, and non-merchant orders have
> no panel to advance them out of `pending` (same convention as
> errand/courier/ride) — and the fare is the courier curve applied to the
> summed haversine legs of the whole route. First/last stops are mirrored
> into the flat `pickup_*`/`dropoff_*` columns for feed proximity scoring.

~~The customer app throws `UnsupportedError` for `OrderType.multiStop`~~ —
**client flip done:** `place()` POSTs `/orders/multi-stop`, re-basing the
builder's 1-based display `seq` to the 0-based wire contract and passing
kinds through; the live-mode screen guard is gone and the builder picks
real saved addresses per stop.

- **Guard:** JWT (any authenticated customer).
- **Body:**
  ```json
  {
    "stops": [
      { "seq": 0, "kind": "pickup",  "label": "…", "lat": 0, "lng": 0, "payload": { } },
      { "seq": 1, "kind": "deliver", "label": "…", "lat": 0, "lng": 0, "payload": { } }
    ],
    "notes": "…",
    "payment": "cod"
  }
  ```
  `kind ∈ {pickup, deliver}`; ≥2 stops; `seq` contiguous from 0. Validate with a
  DTO (`@IsArray`, `@ValidateNested`, `@ArrayMinSize(2)`).
- **Behavior:** insert `type='multi_stop'`, `status='pending'`,
  `customer_id=auth.uid()`, then the `order_stops` rows. **Reuse `place_order`**
  — it already fans out `payload->'stops'` into `order_stops` (see the
  `for v_stop in …` loop); just build the payload with `type:'multi_stop'` and
  the `stops` array and call it. No new RPC needed.
- **Response:** order JSON (from `place_order`). **201.**
- **Client flip:** replace the `throw UnsupportedError(...)` arm with
  `_api.post('/orders/multi-stop', body: {'stops': …, 'notes': draft.notes})`
  and drop the live-mode screen guard.

### 2. `PATCH /orders/:id/reject` (merchant) — **done**

> **Built:** `OrdersService.merchantReject` — membership-scoped (non-member
> → 404, matching the RPC's "not yours = not found"), admin bypass,
> `pending|preparing → canceled` with `canceled_by='merchant'` + trimmed
> reason, 409 once `assigned_rider_id` is set or the status is past
> `preparing`; the final UPDATE re-checks the guards atomically so a
> concurrent rider claim also lands on 409.

~~The panel currently reaches around the server with a direct
`merchant_reject_order` RPC call~~ — **panel flip done:** `useRejectOrder`
PATCHes `/orders/:id/reject` like accept/ready; the RPC remains the tested
DB-level twin only.

- **Guard:** JWT **and** `merchant_users` membership of the order's store
  (403 otherwise). Role `merchant`.
- **Body:** `{ "reason": string }` (optional; trimmed, empty → null).
- **Behavior:** call the existing **`merchant_reject_order(:id, :reason)`** RPC
  — it does `pending|preparing → canceled`, sets `canceled_reason` +
  `canceled_by='merchant'`, and **refuses once `assigned_rider_id` is set**
  (raise → map to **409 Conflict**). "Not yours / not found" → 404.
- **Response:** order JSON. **200.**
- **Panel flip:** `apps/merchant-web/src/features/orders/data.ts` swaps its
  direct RPC for `cartmanApi.patch(\`/orders/${id}/reject\`, {reason})`,
  matching how accept/ready already route through `cartmanApi`.

### 3. `merchant_users` membership guard on accept/ready — **done**

> **Built:** `OrdersService.merchantAccept` / `merchantMarkReady` (replacing
> the unscoped `updateStatus`): non-member merchants get **403**, admins
> bypass membership, and the legal transition is now enforced (`accept`
> only from `pending`, `ready` only from `preparing` — anything else 409,
> so a canceled/delivered order can no longer be "resurrected"). Routes and
> success responses unchanged for the panel.

Today the server's `accept`/`ready` guard checks `profiles.role` **only** — any
`merchant`-role user can act on **any** store's order server-side (the panel
only *sees* its own via RLS, but the write path is too loose).
`backend-schema.md §Merchant Panel` flags this explicitly.

- **Fix:** in the accept/ready handlers, either call the membership-scoped RPCs
  **`merchant_accept_order(:id)` / `merchant_mark_ready(:id)`** (which already
  `exists (select 1 from merchant_users …)`), or add the same
  `merchant_users`-membership check before the UPDATE. Non-member → **403**.
- No client change — same routes, same responses.

### 4. `canceled_by='customer'` on `PATCH /orders/:id/cancel` — **done**

> **Built:** cancel now stamps `canceled_by='customer'` and stores an
> optional trimmed `{reason}` body as `canceled_reason`. Not-found /
> not-yours → **404**; owned-but-too-late (rider assigned or past
> `ready_for_pickup`) → **409** (was a blanket 400). The cancellable set is
> unchanged (`pending|ready_for_pickup`, unassigned). **RPC parity done:**
> `cancel_order(p_order_id, p_reason)` ships in
> `supabase/migrations/20260717000100_cancel_order.sql` with the SAME
> cancellable set as this route — `ready_for_pickup` must be cancellable
> because merchant-less orders are born there (MM-4), `preparing` is
> refused because the merchant is already cooking.

The customer cancel path exists but doesn't attribute the cancellation.

- **Fix:** on the customer cancel UPDATE, also set `canceled_by='customer'`
  (and `canceled_reason` if the body carries one). Only the owner
  (`customer_id = auth.uid()`) may cancel, and only before a rider is assigned
  / terminal status (mirror `merchant_reject_order`'s `assigned_rider_id is
  null` refusal → 409).
- **Optional parity:** add a `cancel_order(:id, :reason)` RPC in
  `supabase/migrations` so this has a tested DB-level equivalent like every
  other transition (there is none today — the only cancel path is this route).
- **Client:** already parses `canceled_reason`/`canceled_by` once the customer
  `Order` model gains the two nullable fields (noted in `go-live-gaps.md`).

### 5. `POST /storage/upload` customer scope (INT-9) — **done**

> **Built:** `StorageService.resolveUploadTarget` — customer **and rider**
> uploads are forced to `avatars/{auth.uid()}/{basename}` in the default
> bucket (the key is rebuilt from the basename, so `../`, another uid, or a
> caller-chosen bucket cannot escape the prefix), `image/*` only, 5 MB cap.
> Admin/merchant keep free-form bucket/path. Response still
> `{path, publicUrl}`, 201.

The route is `@Roles('admin','merchant')`, so a customer avatar upload
**403s** (`storage_repository.dart` documents this precisely).

- **Fix:** allow an authenticated customer to upload to a **self-scoped**
  prefix. Namespace the object key by uid: `avatars/{auth.uid()}/{filename}`
  (ignore/override a client `path` that would escape the caller's prefix — no
  `../`, no other uid). Keep admin/merchant for their buckets.
- Enforce content-type allowlist (`image/*`) and a max size; return
  `{ publicUrl }` (the client reads exactly `res['publicUrl']`).
- **Response:** `{ "publicUrl": "https://…" }`. **201.**

### 6. CORS for the panel origin (INT-14) — **already done**

> **Built (previously):** `main.ts` already drives `app.enableCors` from a
> comma-separated `CORS_ORIGINS` env var, required in production by
> `validateEnv()`; dev falls back to allow-all with a loud warning. Nothing
> further to build — set the deployed panel origin in `CORS_ORIGINS`.

Server sends no CORS headers; the panel's `/cartman-api` proxy is dev/preview
only, so a deployed panel can't call the server cross-origin.

- **Fix:** enable CORS for the panel origin(s) —
  `app.enableCors({ origin: [<panel URLs>], credentials: false })` (Bearer
  token, no cookies, so `credentials:false` is fine). Drive the allowlist from
  an env var. Alternatively front the deployed panel with a same-origin host
  proxy and skip CORS.

### 7. FCM fan-out (INT-2) — **done (server side; needs creds to go live)**

> **Built:** `FcmService` — FCM **HTTP v1** with zero new dependencies (the
> service-account OAuth2 JWT-bearer exchange is hand-rolled with
> `node:crypto` + `fetch`, token cached ~1h). `WebhooksService` now looks up
> `device_tokens` and fans out on the Supabase order webhook: every status
> change → the customer; assigned orders → that rider; `ready_for_pickup`
> with no rider → all on-duty riders minus wallet-locked ones. Tokens FCM
> reports `UNREGISTERED`/`NOT_FOUND` are pruned. Missing
> `FCM_PROJECT_ID`/`FCM_CLIENT_EMAIL`/`FCM_PRIVATE_KEY` degrades to a warned
> no-op — the webhook never crashes. Going live is now purely an ops step:
> set the three env vars from a Firebase service account.

`webhooks.service.ts` logs instead of sending; device-token endpoints already
persist tokens. New-order / status pushes therefore never arrive.

- **Fix:** implement FCM **HTTP v1** send (OAuth2 service-account creds in
  server secrets — never in the app bundle), look up `device_tokens` for the
  target user, send, and prune tokens that come back `UNREGISTERED`/`NOT_FOUND`.
- Trigger points: merchant `ready` → notify assigned/eligible riders; rider
  status changes → notify the customer. Client registration plumbing
  (`DeviceTokenRepository`) is ready; see `dev-runbook.md §10`.

---

## Build order — all shipped

All seven items above are implemented and unit-tested in this repo (see the
`§`-labelled describe blocks in `orders.service.spec.ts`,
`place-order.dto.spec.ts`, `storage.service.spec.ts`, `fcm.service.spec.ts`,
and `webhooks.service.spec.ts` — membership 403s, the 404/409 refusals, seq
contiguity, path-escape attempts, token pruning, and the rider fan-out
eligibility are all covered).

Remaining follow-ups (2026-07-18 — client flips and DB parity are done):

1. ~~**Client flips**~~ — done: multi-stop `UnsupportedError` arm replaced
   with `POST /orders/multi-stop`; panel reject moved to
   `PATCH /orders/:id/reject`; `Order` parses `canceled_reason`/
   `canceled_by` and carries `recipient_name`/`recipient_phone` on courier
   drafts (C-6.3 write side, collected on the delivery-details screen).
2. **Ops** — set `CORS_ORIGINS` for the deployed panel origin and the three
   `FCM_*` env vars from a Firebase service account; `supabase db push` the
   pending migrations (`20260714000000_handle_new_user_phone.sql`,
   `20260717000100_cancel_order.sql`).
3. ~~**Optional DB parity**~~ — done: `cancel_order(:id, :reason)` in
   `supabase/migrations/20260717000100_cancel_order.sql`, exercised by 6
   cases in `supabase/tests/merchant_panel.test.ts`.
