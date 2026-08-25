import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  order_type,
  order_status,
  payment_method,
  Prisma,
} from '@prisma/client';
import { LedgerService } from '../ledger/ledger.service';
import { haversineKm } from './geo';
import { serializeOrder } from './serialize-order';
import type { PlaceMerchantOrderDto } from './dto/place-order.dto';

// -₱2,000 in centavos — mirrors LedgerService's LOCK_FLOOR / accept_order() RPC.
export const WALLET_LOCK_FLOOR = -200_000n;

// Statuses that count toward a rider's active order load for the
// queue-depth guard on claimOrder (max 1 active + 1 queued). Exported for
// reuse by AdminService's reassign-order active-count guard.
export const ACTIVE_RIDER_STATUSES: order_status[] = [
  order_status.accepted,
  order_status.arrived_at_merchant,
  order_status.picked_up,
  order_status.in_transit,
];
export const MAX_ACTIVE_ORDERS_PER_RIDER = 2;

// Legal rider-driven forward transitions. advanceRiderStatus rejects any
// target that isn't exactly NEXT[order.status] for the order's current status.
const NEXT: Partial<Record<order_status, order_status>> = {
  accepted: order_status.arrived_at_merchant,
  arrived_at_merchant: order_status.picked_up,
  picked_up: order_status.in_transit,
  in_transit: order_status.delivered,
};

// Statuses an order can never leave. `delivery_failed` belongs here with the
// other two: the rider attempted the delivery and it failed, and the row is
// closed pending an operations decision, not waiting on anyone in the app.
//
// Keep this a single exported list rather than repeating
// `notIn: [delivered, canceled]` at each call site. That idiom is a deny-list,
// so every new terminal status silently reads as "still active" everywhere it
// was spelled out — which is exactly how `delivery_failed` would otherwise have
// landed in the admin active counts and stayed admin-cancelable.
export const TERMINAL_ORDER_STATUSES: order_status[] = [
  order_status.delivered,
  order_status.canceled,
  order_status.delivery_failed,
];

// round(avg(stars), 2) twin for the rate_order RPC's aggregate recompute.
// Computed from the exact integer sum/count (stars are small ints) so the
// half-up rounding at x.xx5 boundaries matches Postgres round(numeric, 2);
// `fallback` mirrors the RPC's coalesce (merchants 0, riders 5.0).
function starAverage(
  sum: number | null,
  count: number,
  fallback: number,
): number {
  if (sum == null || count === 0) return fallback;
  return Math.round((sum * 100) / count) / 100;
}

async function nextRefNo(tx: {
  $queryRaw: <T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;
}): Promise<string> {
  const [{ nextval }] = await tx.$queryRaw<
    { nextval: bigint }[]
  >`select nextval('order_ref_seq')`;
  return `CMN-${nextval.toString().padStart(6, '0')}`;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
  ) {}

  // Delegates to the shared helper (also used by FeedService) so both
  // return the same wire shape for order rows.
  private serializeOrder<T extends Record<string, any>>(order: T): T {
    return serializeOrder(order);
  }

  async placeFoodOrder(customerId: string, data: PlaceMerchantOrderDto) {
    return this.placeMerchantOrder(customerId, data, order_type.food);
  }

  async placeGroceryOrder(customerId: string, data: PlaceMerchantOrderDto) {
    return this.placeMerchantOrder(customerId, data, order_type.grocery);
  }

  // Typed against the DTO the controller already validates, rather than `any`
  // — the drop-off resolution below decides whether an order is deliverable,
  // which is not a thing to work out from an untyped bag.
  private async placeMerchantOrder(
    customerId: string,
    data: PlaceMerchantOrderDto,
    type: typeof order_type.food | typeof order_type.grocery,
  ) {
    const {
      merchant_id,
      items,
      notes,
      dropoff_instruction,
      dropoff_note,
      dropoff_lat,
      dropoff_lng,
      dropoff_text,
    } = data;
    if (!items || items.length === 0) {
      throw new BadRequestException('Order must contain items');
    }

    return this.prisma.$transaction(async (tx) => {
      const merchant = await tx.merchants.findUnique({
        where: { id: merchant_id },
      });
      if (!merchant) throw new BadRequestException('Merchant not found');

      // A store that paused while the customer was building a basket would
      // otherwise be handed an order it has already said it cannot cook.
      //
      // The DB twin `place_order` grew the same guard in
      // 20260818000100_merchant_busy_until.sql, and its header calls this path
      // out by name: this service writes `orders` through Prisma rather than
      // calling that RPC, so the guard has to exist in both or a client one
      // version behind still gets in. Keep the two in step.
      //
      // Strictly `>`: `busy_until` is the moment the pause ends, so a store is
      // taking orders again *at* that instant. Null, or any past instant, is
      // trading normally — the timestamp expires on its own, which is why it is
      // not an `is_busy` flag. Treating non-null as busy would shut a store
      // permanently the first time it paused.
      if (merchant.busy_until && merchant.busy_until > new Date()) {
        // 409, not 400: the request is well formed and the customer did
        // nothing wrong — the store's state refuses, and it will stop refusing
        // by itself. Same sentence the RPC raises, so the customer sees one
        // wording whichever write path their app version uses.
        throw new ConflictException(
          'This store has paused new orders. Please try again shortly.',
        );
      }

      let subtotal = 0n;
      // Unchecked variant: these rows carry the `menu_item_id` FK directly
      // rather than a nested relation connect.
      const orderItemsData: Prisma.order_itemsUncheckedCreateWithoutOrderInput[] =
        [];

      for (const item of items) {
        const menuItem = await tx.menu_items.findUnique({
          where: { id: item.menu_item_id },
        });
        if (!menuItem || menuItem.merchant_id !== merchant_id) {
          throw new BadRequestException(
            `Invalid menu item ${item.menu_item_id}`,
          );
        }
        if (!menuItem.in_stock) {
          throw new BadRequestException(
            `Item ${menuItem.name} is out of stock`,
          );
        }

        subtotal += BigInt(menuItem.price) * BigInt(item.qty);

        orderItemsData.push({
          menu_item_id: menuItem.id,
          name: menuItem.name,
          qty: item.qty,
          unit_price: menuItem.price,
          // The DTO keeps modifiers as `unknown[]` (the client's shape is not
          // fixed yet); Prisma wants a JSON input value for the jsonb column.
          modifiers: (item.modifiers ?? []) as Prisma.InputJsonValue,
        });
      }

      const delivery_fee = merchant.delivery_fee;
      const delivery_payout = delivery_fee; // rider gets full delivery fee (v1)
      const total = subtotal + delivery_fee;
      const ref_no = await nextRefNo(tx);

      // Where the rider actually takes it. Food and grocery were the only
      // order types that never wrote a drop-off — errand, courier, ride and
      // multi-stop all do — so a live food order reached the feed with
      // dropoff_lat/lng/text all null and the rider's active screen, which
      // renders the destination only `if (order.dropoffText != null)`, showed
      // them nowhere to go.
      //
      // A per-order drop-off (I2) wins when the client sends one; otherwise
      // resolve the customer's default saved address, which is what checkout
      // has always assumed happens here.
      let resolvedLat = dropoff_lat;
      let resolvedLng = dropoff_lng;
      let resolvedText = dropoff_text;
      if (resolvedLat == null || resolvedLng == null) {
        const fallback = await tx.addresses.findFirst({
          where: { user_id: customerId },
          orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
        });
        // An order with no destination is unfulfillable, and the merchant
        // would have cooked it before anyone noticed. Checkout already
        // requires a default address, so this is a guard, not a new gate.
        if (!fallback) {
          throw new BadRequestException(
            'Add a delivery address before placing an order',
          );
        }
        resolvedLat = fallback.lat;
        resolvedLng = fallback.lng;
        resolvedText = resolvedText ?? fallback.text_address;
      }

      const order = await tx.orders.create({
        data: {
          customer_id: customerId,
          merchant_id,
          merchant_name: merchant.name,
          type,
          status: order_status.pending,
          ref_no,
          subtotal,
          delivery_fee,
          delivery_payout,
          total,
          notes,
          dropoff_lat: resolvedLat,
          dropoff_lng: resolvedLng,
          dropoff_text: resolvedText,
          // Undefined leaves the DB default (hand_to_me) in place, so a body
          // that omits these is byte-for-byte the order it always was.
          dropoff_instruction,
          dropoff_note,
          order_items: {
            create: orderItemsData,
          },
        },
        include: { order_items: true },
      });
      return this.serializeOrder(order);
    });
  }

  async placeErrandOrder(customerId: string, data: any) {
    const { errand_payload, notes, dropoff_lat, dropoff_lng, dropoff_text } =
      data;

    // A pabili has to be handed to the customer somewhere — without a
    // drop-off the order is unfulfillable (the DB twin's place_order accepts
    // the same fields; same guard style as courier/ride).
    if (!dropoff_lat || !dropoff_lng) {
      throw new BadRequestException('Drop-off coordinates are required');
    }

    const delivery_fee = 10000n; // ₱100 — errand base fee
    const delivery_payout = delivery_fee;

    return this.prisma.$transaction(async (tx) => {
      const ref_no = await nextRefNo(tx);
      const order = await tx.orders.create({
        data: {
          customer_id: customerId,
          type: order_type.errand,
          // Errand/courier/ride have no merchant prep step, so there is no
          // "pending -> preparing -> ready" advance to wait on; they are
          // claimable by riders the instant they're placed. There is also
          // no merchant panel to move them out of `pending`, so leaving
          // them there would make them unclaimable forever.
          status: order_status.ready_for_pickup,
          ref_no,
          dropoff_lat,
          dropoff_lng,
          dropoff_text,
          delivery_fee,
          delivery_payout,
          total: delivery_fee,
          errand_payload,
          notes,
        },
      });
      return this.serializeOrder(order);
    });
  }

  async placeCourierOrder(customerId: string, data: any) {
    const {
      pickup_lat,
      pickup_lng,
      pickup_text,
      dropoff_lat,
      dropoff_lng,
      dropoff_text,
      notes,
      recipient_name,
      recipient_phone,
    } = data;

    if (!pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng) {
      throw new BadRequestException(
        'Pickup and dropoff coordinates are required',
      );
    }

    // Fare: ₱40 base (4000¢) + ₱12/km (1200¢/km), minimum ₱50 (5000¢)
    const delivery_fee = this.calcHaversineFare(
      pickup_lat,
      pickup_lng,
      dropoff_lat,
      dropoff_lng,
    );
    const delivery_payout = delivery_fee;

    return this.prisma.$transaction(async (tx) => {
      const ref_no = await nextRefNo(tx);
      const order = await tx.orders.create({
        data: {
          customer_id: customerId,
          type: order_type.pickup_delivery,
          // No merchant prep step for courier orders — born ready_for_pickup
          // so riders can claim immediately (see placeErrandOrder comment).
          status: order_status.ready_for_pickup,
          ref_no,
          pickup_lat,
          pickup_lng,
          pickup_text,
          dropoff_lat,
          dropoff_lng,
          dropoff_text,
          delivery_fee,
          delivery_payout,
          total: delivery_fee,
          notes,
          recipient_name,
          recipient_phone,
        },
      });
      return this.serializeOrder(order);
    });
  }

  async placeRideOrder(customerId: string, data: any) {
    const {
      pickup_lat,
      pickup_lng,
      pickup_text,
      dropoff_lat,
      dropoff_lng,
      dropoff_text,
      notes,
    } = data;

    if (!pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng) {
      throw new BadRequestException(
        'Pickup and dropoff coordinates are required',
      );
    }

    // Reuses the same haversine fare curve as courier (TODO: confirm the
    // intended Pasakay base/per-km rate against the backlog docs — the
    // courier rate is used here as a placeholder, not a confirmed fare).
    const delivery_fee = this.calcHaversineFare(
      pickup_lat,
      pickup_lng,
      dropoff_lat,
      dropoff_lng,
    );
    const delivery_payout = delivery_fee;

    return this.prisma.$transaction(async (tx) => {
      const ref_no = await nextRefNo(tx);
      const order = await tx.orders.create({
        data: {
          customer_id: customerId,
          type: order_type.ride,
          // No merchant prep step for ride orders — born ready_for_pickup
          // so riders can claim immediately (see placeErrandOrder comment).
          status: order_status.ready_for_pickup,
          ref_no,
          pickup_lat,
          pickup_lng,
          pickup_text,
          dropoff_lat,
          dropoff_lng,
          dropoff_text,
          delivery_fee,
          delivery_payout,
          total: delivery_fee,
          notes,
        },
      });
      return this.serializeOrder(order);
    });
  }

  async placeMultiStopOrder(
    customerId: string,
    data: {
      stops: Array<{
        seq: number;
        kind: string;
        label?: string;
        lat: number;
        lng: number;
        payload?: Record<string, unknown> | null;
      }>;
      notes?: string;
      payment?: payment_method;
    },
  ) {
    const { stops, notes, payment } = data;

    // seq must be contiguous from 0 (§1). Sorted first so clients may send
    // stops in any array order — seq is the route order, not array order.
    const ordered = [...stops].sort((a, b) => a.seq - b.seq);
    if (ordered.some((stop, i) => stop.seq !== i)) {
      throw new BadRequestException(
        'Stop seq values must be contiguous starting from 0',
      );
    }

    // Same base/per-km curve as courier, applied to the whole route (sum of
    // consecutive legs).
    let routeKm = 0;
    for (let i = 1; i < ordered.length; i++) {
      routeKm += haversineKm(
        ordered[i - 1].lat,
        ordered[i - 1].lng,
        ordered[i].lat,
        ordered[i].lng,
      );
    }
    const delivery_fee = this.fareForDistance(routeKm);
    const delivery_payout = delivery_fee;

    const first = ordered[0];
    const last = ordered[ordered.length - 1];

    return this.prisma.$transaction(async (tx) => {
      const ref_no = await nextRefNo(tx);
      const order = await tx.orders.create({
        data: {
          customer_id: customerId,
          type: order_type.multi_stop,
          // Born ready_for_pickup like every other non-merchant order type
          // (see placeErrandOrder) — there is no merchant prep step, and a
          // `pending` multi-stop order would never surface in the rider feed.
          status: order_status.ready_for_pickup,
          ref_no,
          // First/last stop mirrored into the flat pickup/dropoff columns so
          // feed proximity scoring and list displays work without joining
          // order_stops.
          pickup_lat: first.lat,
          pickup_lng: first.lng,
          pickup_text: first.label ?? null,
          dropoff_lat: last.lat,
          dropoff_lng: last.lng,
          dropoff_text: last.label ?? null,
          delivery_fee,
          delivery_payout,
          total: delivery_fee,
          notes,
          payment,
          order_stops: {
            create: ordered.map((stop) => ({
              seq: stop.seq,
              kind: stop.kind,
              label: stop.label ?? '',
              lat: stop.lat,
              lng: stop.lng,
              payload: stop.payload ?? undefined,
            })),
          },
        },
        include: { order_stops: true },
      });
      return this.serializeOrder(order);
    });
  }

  private calcHaversineFare(
    pickupLat: number,
    pickupLng: number,
    dropoffLat: number,
    dropoffLng: number,
  ): bigint {
    return this.fareForDistance(
      haversineKm(pickupLat, pickupLng, dropoffLat, dropoffLng),
    );
  }

  // Fare curve shared by courier/ride (single leg) and multi-stop (whole
  // route): ₱40 base (4000¢) + ₱12/km (1200¢/km), minimum ₱50 (5000¢).
  private fareForDistance(distanceKm: number): bigint {
    const BASE = 4000n;
    const PER_KM = 1200n;
    const MIN_FEE = 5000n;
    const raw = BASE + BigInt(Math.round(distanceKm)) * PER_KM;
    return raw < MIN_FEE ? MIN_FEE : raw;
  }

  async getHistory(customerId: string) {
    const orders = await this.prisma.orders.findMany({
      where: { customer_id: customerId },
      orderBy: { created_at: 'desc' },
      take: 20,
      include: {
        merchant: { select: { name: true, image_url: true } },
        order_items: true,
        order_stops: true,
      },
    });
    return orders.map((order) => this.serializeOrder(order));
  }

  // Merchant Panel write path (cartman-server-endpoints.md §3): @Roles alone
  // only proves the caller is *a* merchant, not a member of *this* order's
  // store — RLS scopes what the panel can read, but the server write path
  // must enforce membership itself. Admins bypass membership (they act on any
  // store), everyone still goes through the status-transition check.
  private async loadOrderForMerchantAction(
    orderId: string,
    actor: { id: string; role: string },
  ) {
    const order = await this.prisma.orders.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Order not found');

    if (actor.role !== 'admin') {
      // Orders without a merchant (errand/courier/ride/multi-stop) have no
      // store to be a member of — no merchant may act on them.
      if (!order.merchant_id) {
        throw new ForbiddenException('Not a member of this store');
      }
      const membership = await this.prisma.merchant_users.findFirst({
        where: { user_id: actor.id, merchant_id: order.merchant_id },
      });
      if (!membership) {
        throw new ForbiddenException('Not a member of this store');
      }
    }

    return order;
  }

  async merchantAccept(orderId: string, actor: { id: string; role: string }) {
    const order = await this.loadOrderForMerchantAction(orderId, actor);
    if (order.status !== order_status.pending) {
      throw new ConflictException('Order can no longer be accepted');
    }
    const updated = await this.prisma.orders.update({
      where: { id: orderId },
      data: { status: order_status.preparing },
    });
    return this.serializeOrder(updated);
  }

  async merchantMarkReady(
    orderId: string,
    actor: { id: string; role: string },
  ) {
    const order = await this.loadOrderForMerchantAction(orderId, actor);
    if (order.status !== order_status.preparing) {
      throw new ConflictException('Order is not being prepared');
    }
    const updated = await this.prisma.orders.update({
      where: { id: orderId },
      data: { status: order_status.ready_for_pickup },
    });
    return this.serializeOrder(updated);
  }

  // PATCH /orders/:id/reject (cartman-server-endpoints.md §2) — server-side
  // twin of the merchant_reject_order RPC: pending|preparing → canceled with
  // canceled_by='merchant', refusing once a rider is assigned (409). Unlike
  // accept/ready's 403, non-membership here is a 404 ("not yours" reads the
  // same as "not found"), matching the RPC's scoped-WHERE behavior.
  async merchantReject(
    orderId: string,
    actor: { id: string; role: string },
    reason?: string,
  ) {
    const order = await this.prisma.orders.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Order not found');

    if (actor.role !== 'admin') {
      const membership = order.merchant_id
        ? await this.prisma.merchant_users.findFirst({
            where: { user_id: actor.id, merchant_id: order.merchant_id },
          })
        : null;
      if (!membership) throw new NotFoundException('Order not found');
    }

    if (order.assigned_rider_id != null) {
      throw new ConflictException(
        'A rider is already assigned — the order can no longer be rejected',
      );
    }
    if (
      order.status !== order_status.pending &&
      order.status !== order_status.preparing
    ) {
      throw new ConflictException('Order can no longer be rejected');
    }

    const result = await this.prisma.orders.updateMany({
      where: {
        id: orderId,
        assigned_rider_id: null,
        status: { in: [order_status.pending, order_status.preparing] },
      },
      data: {
        status: order_status.canceled,
        canceled_by: 'merchant',
        canceled_reason: reason?.trim() || null,
      },
    });

    // A rider claiming between the read above and this guarded update lands
    // here rather than silently overwriting the claim.
    if (result.count === 0) {
      throw new ConflictException('Order can no longer be rejected');
    }

    const updated = await this.prisma.orders.findUnique({
      where: { id: orderId },
    });
    return this.serializeOrder(updated!);
  }

  async claimOrder(orderId: string, riderId: string) {
    const rider = await this.prisma.riders.findUnique({
      where: { id: riderId },
    });
    if (!rider?.is_active) {
      throw new BadRequestException('Go on-duty before claiming orders');
    }

    const netCash = await this.ledgerService.getNetCash(riderId);
    if (netCash <= WALLET_LOCK_FLOOR) {
      throw new BadRequestException(
        'Wallet locked — remit cash before accepting orders',
      );
    }

    const activeCount = await this.prisma.orders.count({
      where: {
        assigned_rider_id: riderId,
        status: { in: ACTIVE_RIDER_STATUSES },
      },
    });
    if (activeCount >= MAX_ACTIVE_ORDERS_PER_RIDER) {
      throw new BadRequestException('Finish your current orders first');
    }

    const result = await this.prisma.orders.updateMany({
      where: {
        id: orderId,
        assigned_rider_id: null,
        status: order_status.ready_for_pickup,
      },
      data: {
        assigned_rider_id: riderId,
        status: order_status.accepted,
      },
    });

    if (result.count === 0) {
      throw new BadRequestException(
        'Order is no longer available or already claimed',
      );
    }

    const order = await this.prisma.orders.findUnique({
      where: { id: orderId },
      // The claim response boots the rider's active screen — carry the line
      // items and the multi-stop route (realtime rows never embed relations).
      include: { order_items: true, order_stops: true },
    });
    return {
      ...this.serializeOrder(order!),
      queued: activeCount > 0,
    };
  }

  async advanceRiderStatus(
    orderId: string,
    riderId: string,
    newStatus: order_status,
  ) {
    const existing = await this.prisma.orders.findUnique({
      where: { id: orderId },
    });
    if (!existing || existing.assigned_rider_id !== riderId) {
      throw new NotFoundException('Order not found');
    }
    if (newStatus !== NEXT[existing.status]) {
      throw new BadRequestException('Illegal status transition');
    }

    const order = await this.prisma.$transaction(async (tx) => {
      const order = await tx.orders.update({
        where: {
          id: orderId,
          assigned_rider_id: riderId,
        },
        data: {
          status: newStatus,
          // Parity with advance_order_status, which stamps this on the same
          // transition. This server reimplements that RPC rather than calling
          // it, and it had been writing `status` alone — so every delivery
          // completed through this route left `delivered_at` null and only
          // deliveries made through the RPC recorded a completion time.
          // Server clock, set once, never client-supplied.
          ...(newStatus === order_status.delivered
            ? { delivered_at: new Date() }
            : {}),
        },
      });

      if (newStatus === order_status.delivered) {
        // Idempotency guard — load-bearing, do not remove as "dead code":
        // the transition guard above reads the order OUTSIDE this transaction,
        // so two concurrent in_transit→delivered requests can BOTH pass it
        // with the same stale read. Postgres's row lock serializes the two
        // tx.orders.update calls, and THIS check is what stops the second
        // transaction from crediting/debiting the rider twice.
        const alreadyRewarded = await tx.rider_wallet_transactions.findFirst({
          where: {
            order_id: order.id,
            type: 'credit_delivery_reward',
          },
        });

        if (!alreadyRewarded) {
          // Credit rider's delivery share (delivery_payout, not the full
          // delivery_fee). Inlined here (rather than via LedgerService)
          // because it must run inside this same transaction — amount is
          // always positive, sign is inferred from `type` (append-only ledger).
          await tx.rider_wallet_transactions.create({
            data: {
              rider_id: riderId,
              type: 'credit_delivery_reward',
              amount: BigInt(order.delivery_payout),
              order_id: order.id,
            },
          });

          // Debit COD liability — amount is positive; sign comes from txn type
          if (order.payment === 'cod') {
            await tx.rider_wallet_transactions.create({
              data: {
                rider_id: riderId,
                type: 'debit_cod_order',
                amount: BigInt(order.total),
                order_id: order.id,
              },
            });
          }
        }
      }

      return order;
    });

    return this.serializeOrder(order);
  }

  async cancelOrder(orderId: string, customerId: string, reason?: string) {
    // Pre-read splits "not yours / not found" (404) from "too late" (409,
    // mirroring merchant_reject_order's assigned-rider refusal). The guarded
    // updateMany below remains the atomic gate — a rider claiming between
    // the read and the update still lands in the 409 branch.
    const existing = await this.prisma.orders.findUnique({
      where: { id: orderId },
    });
    if (!existing || existing.customer_id !== customerId) {
      throw new NotFoundException('Order not found');
    }

    const result = await this.prisma.orders.updateMany({
      where: {
        id: orderId,
        customer_id: customerId,
        assigned_rider_id: null,
        status: { in: [order_status.pending, order_status.ready_for_pickup] },
      },
      data: {
        status: order_status.canceled,
        canceled_by: 'customer',
        canceled_reason: reason?.trim() || null,
      },
    });

    if (result.count === 0) {
      throw new ConflictException('Order can no longer be cancelled');
    }

    const order = await this.prisma.orders.findUnique({
      where: { id: orderId },
    });
    return this.serializeOrder(order!);
  }

  // POST /orders/:id/rating (cartman-server-endpoints.md §Ratings) — server
  // twin of the rate_order RPC (20260719000200_order_ratings.sql). Same
  // refusal map as the RPC: not-yours reads as not-found (404, like cancel),
  // only delivered orders can be rated (409), at least one score (400), one
  // rating per order — the order_ratings.order_id UNIQUE is the atomic gate,
  // so a re-rate (including a concurrent double-submit) surfaces as P2002 and
  // maps to 409, mirroring the RPC's unique_violation catch. The insert and
  // the platform-owned merchants.rating / riders.rating recompute run in one
  // transaction.
  async rateOrder(
    orderId: string,
    customerId: string,
    data: { merchant_stars?: number; rider_stars?: number; comment?: string },
  ) {
    const { merchant_stars, rider_stars, comment } = data;

    const order = await this.prisma.orders.findUnique({
      where: { id: orderId },
    });
    if (!order || order.customer_id !== customerId) {
      throw new NotFoundException('Order not found');
    }
    if (order.status !== order_status.delivered) {
      throw new ConflictException('Only delivered orders can be rated');
    }
    if (merchant_stars == null && rider_stars == null) {
      throw new BadRequestException('Provide a merchant or rider rating');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Like the RPC, merchant_id/rider_id snapshot the order's parties. A
        // merchant-less order (errand/courier/ride/multi-stop) stores
        // merchant_id null — a merchant_stars sent for one is stored inert
        // and never feeds any merchant aggregate (the recompute below is
        // gated on the order actually having a merchant).
        const rating = await tx.order_ratings.create({
          data: {
            order_id: orderId,
            customer_id: customerId,
            merchant_id: order.merchant_id,
            rider_id: order.assigned_rider_id,
            merchant_stars: merchant_stars ?? null,
            rider_stars: rider_stars ?? null,
            comment: comment?.trim() || null,
          },
        });

        // Recompute the platform-owned aggregates from the ratings table —
        // round(avg(stars), 2) over non-null scores, with the RPC's coalesce
        // fallbacks (merchants 0, riders 5.0). updateMany mirrors the RPC's
        // plain UPDATE: zero matching rows is a no-op, not an error.
        if (order.merchant_id != null && merchant_stars != null) {
          const agg = await tx.order_ratings.aggregate({
            where: {
              merchant_id: order.merchant_id,
              merchant_stars: { not: null },
            },
            _sum: { merchant_stars: true },
            _count: { merchant_stars: true },
          });
          await tx.merchants.updateMany({
            where: { id: order.merchant_id },
            data: {
              rating: starAverage(
                agg._sum.merchant_stars,
                agg._count.merchant_stars,
                0,
              ),
            },
          });
        }
        if (order.assigned_rider_id != null && rider_stars != null) {
          const agg = await tx.order_ratings.aggregate({
            where: {
              rider_id: order.assigned_rider_id,
              rider_stars: { not: null },
            },
            _sum: { rider_stars: true },
            _count: { rider_stars: true },
          });
          await tx.riders.updateMany({
            where: { id: order.assigned_rider_id },
            data: {
              rating: starAverage(
                agg._sum.rider_stars,
                agg._count.rider_stars,
                5.0,
              ),
            },
          });
        }

        return rating;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Order already rated');
      }
      throw error;
    }
  }
}
