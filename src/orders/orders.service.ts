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
import { claimableBy, vehicleClass } from './vehicle';
import { resolveSelectedModifiers } from './modifiers';
import { formatPeso } from '../common/peso';
import type {
  PlaceMerchantOrderDto,
  PlacePickupDropoffOrderDto,
} from './dto/place-order.dto';

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

  /**
   * Runs [place] once per (customer, client_order_id).
   *
   * A placement whose response is lost reads on the phone as a failure, and
   * the customer retries with the basket intact — while the first request had
   * already committed. The app sends the same key on every retry of one
   * attempt, so a repeat returns the order that exists instead of creating a
   * second COD order. The partial unique index on (customer_id,
   * client_order_id) settles two identical requests racing each other: the
   * loser's insert fails P2002 and it returns the winner's row.
   *
   * No key (an older app build) places exactly as before.
   */
  async placeOnce<T>(
    customerId: string,
    clientOrderId: string | undefined,
    place: () => Promise<T>,
  ): Promise<T | ReturnType<OrdersService['serializeOrder']>> {
    if (!clientOrderId) return place();
    const existing = await this.findByClientOrderId(customerId, clientOrderId);
    if (existing) return existing;
    try {
      return await place();
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await this.findByClientOrderId(
          customerId,
          clientOrderId,
        );
        if (winner) return winner;
      }
      throw err;
    }
  }

  private async findByClientOrderId(customerId: string, clientOrderId: string) {
    const order = await this.prisma.orders.findFirst({
      where: { customer_id: customerId, client_order_id: clientOrderId },
      include: { order_items: true, order_stops: true },
    });
    return order ? this.serializeOrder(order) : null;
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

      // S9. `is_open` is the store's "trading at all" switch, and the app
      // refuses checkout when it is off (`Merchant.canOrder`) — but the app is
      // not the only client, and production took orders for a closed store.
      // Checked before the pause: a store that is shut is not "back shortly".
      // 409 for the same reason as the pause, in the checkout's own words.
      if (!merchant.is_open) {
        throw new ConflictException(`${merchant.name} is closed right now.`);
      }

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
        // 409 with a sentence, like the closed / paused / minimum refusals:
        // the customer can act on both, the app shows the message as-is, and a
        // 400 would make it retry the order with the options stripped. A dish
        // removed or sold out while the customer sat on checkout lands here.
        if (!menuItem || menuItem.merchant_id !== merchant_id) {
          throw new ConflictException(
            'One of the dishes in your basket is no longer on the menu. ' +
              'Open your cart to remove it.',
          );
        }
        if (!menuItem.in_stock) {
          throw new ConflictException(
            `${menuItem.name} just sold out. ` +
              'Remove it from your cart to place the order.',
          );
        }

        // Options are priced from the dish's own groups, never from the
        // client's `price` — see ./modifiers. A choice the menu no longer
        // offers is a 409 (never a 400, which the app answers by retrying
        // with the choices stripped). The unit price is base + options, which
        // is what the customer's cart showed (`CartLine.unitPriceCentavos`).
        const { snapshot, addedPerUnit } = resolveSelectedModifiers(
          menuItem.modifiers,
          item.modifiers,
        );
        // Floored at zero: a store can price an option below zero ("no
        // rice"), but a line that pays the customer would turn into a
        // negative COD debit on the rider's ledger.
        const rawUnit = BigInt(menuItem.price) + addedPerUnit;
        const unitPrice = rawUnit < 0n ? 0n : rawUnit;

        subtotal += unitPrice * BigInt(item.qty);

        orderItemsData.push({
          menu_item_id: menuItem.id,
          name: menuItem.name,
          qty: item.qty,
          unit_price: unitPrice,
          // A snapshot with the database's names and prices, so a later menu
          // edit cannot rewrite what this customer agreed to pay.
          modifiers: snapshot as unknown as Prisma.InputJsonValue,
        });
      }

      // S8. The store's minimum is on the food — options in, delivery fee
      // out — which is what the cart measures (`MinOrderNudge.isShort`).
      // Production took a ₱125 order at a ₱500-minimum store. 409, never 400:
      // the app retries a 400 with the dish options stripped, which would not
      // lengthen the basket and would lose the customer's choices.
      if (subtotal < merchant.min_order) {
        const short = merchant.min_order - subtotal;
        throw new ConflictException(
          `Add ${formatPeso(short)} more to reach ${merchant.name}'s ` +
            `${formatPeso(merchant.min_order)} minimum order.`,
        );
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
          client_order_id: data.client_order_id,
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
          // The store is the pickup. Without these the rider feed had no
          // distance, the active screen no store pin, and Navigate was hidden
          // for the whole to-store leg. Snapshotted like merchant_name; a
          // store with no pin still places, with null coordinates.
          pickup_lat: merchant.lat ?? undefined,
          pickup_lng: merchant.lng ?? undefined,
          pickup_text: merchant.address?.trim() || merchant.name,
          dropoff_lat: resolvedLat,
          dropoff_lng: resolvedLng,
          dropoff_text: resolvedText,
          // Undefined leaves the DB default (hand_to_me) in place, so a body
          // that omits these is byte-for-byte the order it always was.
          dropoff_instruction,
          // Blank is "no note", not a note of spaces for the rider to read;
          // undefined leaves the column's null default, like an omitted key.
          dropoff_note: dropoff_note?.trim() || undefined,
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
          client_order_id: data.client_order_id,
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

  async placeCourierOrder(
    customerId: string,
    data: PlacePickupDropoffOrderDto,
  ) {
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
      package_size,
      errand_payload,
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
          client_order_id: data.client_order_id,
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
          package_size,
          // Absent or null leaves the column null; the DTO has already
          // checked it is an object.
          errand_payload: (errand_payload ?? undefined) as
            Prisma.InputJsonObject | undefined,
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
    const tricycle = data.required_vehicle === 'tricycle';

    if (!pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng) {
      throw new BadRequestException(
        'Pickup and dropoff coordinates are required',
      );
    }

    // Reuses the same haversine fare curve as courier (TODO: confirm the
    // intended Pasakay base/per-km rate against the backlog docs — the
    // courier rate is used here as a placeholder, not a confirmed fare).
    // A tricycle ride is 1.3× that, as the app quotes it.
    const delivery_fee = this.fareForDistance(
      haversineKm(pickup_lat, pickup_lng, dropoff_lat, dropoff_lng),
      tricycle,
    );
    const delivery_payout = delivery_fee;

    return this.prisma.$transaction(async (tx) => {
      const ref_no = await nextRefNo(tx);
      const order = await tx.orders.create({
        data: {
          customer_id: customerId,
          client_order_id: data.client_order_id,
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
          // Feed and claim filter on this (claimableBy), so a tricycle ride
          // is offered to tricycle riders only.
          required_vehicle: tricycle ? 'tricycle' : undefined,
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
      client_order_id?: string;
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
          client_order_id: data.client_order_id,
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
  //
  // The distance part is rounded in centavos, not kilometres — the same
  // formula as the app's Fare.estimateCentavos and supabase/functions/
  // fare-calc. Rounding the distance first charged 2.6 km as 3 km, so the
  // total differed from the quote the customer confirmed.
  //
  // `tricycle` applies the 1.3× Pasakay tricycle multiplier to the floored
  // fare, as Fare.estimateCentavos(tricycle: true) does.
  private fareForDistance(distanceKm: number, tricycle = false): bigint {
    const BASE = 4000;
    const PER_KM = 1200;
    const MIN_FEE = 5000;
    const TRICYCLE_MULTIPLIER = 1.3;
    const raw = BASE + Math.round(PER_KM * distanceKm);
    const floored = Math.max(raw, MIN_FEE);
    return BigInt(
      tricycle ? Math.round(floored * TRICYCLE_MULTIPLIER) : floored,
    );
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
    // The status is re-checked in the write itself: the read above is not a
    // lock, and a customer cancel landing between the two used to be
    // overwritten — a canceled order revived as `preparing`.
    const updated = await this.guardedWrite(
      () =>
        this.prisma.orders.update({
          where: { id: orderId, status: order_status.pending },
          data: { status: order_status.preparing },
        }),
      'Order can no longer be accepted',
    );
    return this.serializeOrder(updated);
  }

  /**
   * Runs a status write whose `where` names the status it moves from, and
   * turns "no row matched" (P2025 — the order changed since it was read) into
   * the same 409 the pre-check gives, instead of a 500.
   */
  private async guardedWrite<T>(
    write: () => Promise<T>,
    conflict: string,
  ): Promise<T> {
    try {
      return await write();
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new ConflictException(conflict);
      }
      throw err;
    }
  }

  async merchantMarkReady(
    orderId: string,
    actor: { id: string; role: string },
  ) {
    const order = await this.loadOrderForMerchantAction(orderId, actor);
    if (order.status !== order_status.preparing) {
      throw new ConflictException('Order is not being prepared');
    }
    const updated = await this.guardedWrite(
      () =>
        this.prisma.orders.update({
          where: { id: orderId, status: order_status.preparing },
          data: { status: order_status.ready_for_pickup },
        }),
      'Order is not being prepared',
    );
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

    // The claim half of the same gate as GET /orders/feed. Both are needed:
    // the feed is what an honest client reads, and this is what actually moves
    // the money. `accept_order` (the DB twin) has checked `is_verified` since
    // 20260803000200; this path did not, and this is the path the rider app
    // uses. An unapproved rider reaching here is holding a customer's COD cash
    // with nobody having checked who they are.
    if (!rider?.is_verified) {
      throw new ForbiddenException(
        'Your account is still being reviewed — you cannot take orders yet',
      );
    }

    if (!rider.is_active) {
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

    // The vehicle condition sits inside the one conditional write, so it is
    // as atomic as the claim itself; the database trigger
    // `orders_enforce_required_vehicle` holds the same rule for every other
    // writer.
    const cls = vehicleClass(rider.vehicle);
    const result = await this.prisma.orders.updateMany({
      where: {
        id: orderId,
        assigned_rider_id: null,
        status: order_status.ready_for_pickup,
        ...claimableBy(cls),
      },
      data: {
        assigned_rider_id: riderId,
        status: order_status.accepted,
      },
    });

    if (result.count === 0) {
      // Only on the losing path: say "needs a tricycle" rather than "already
      // claimed" when that is the real reason, so the rider does not think
      // they were simply too slow.
      const missed = await this.prisma.orders.findUnique({
        where: { id: orderId },
        select: { required_vehicle: true },
      });
      if (missed?.required_vehicle && missed.required_vehicle !== cls) {
        throw new BadRequestException(
          `This order needs a ${missed.required_vehicle}`,
        );
      }
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

    const order = await this.guardedWrite(
      () =>
        this.prisma.$transaction(async (tx) => {
          const order = await tx.orders.update({
            where: {
              id: orderId,
              assigned_rider_id: riderId,
              // The status this transition starts from, checked in the write: a
              // cancel or unassign between the read above and this line used to
              // be overwritten, reviving the order.
              status: existing.status,
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
            const alreadyRewarded =
              await tx.rider_wallet_transactions.findFirst({
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

              // S10. advance_order_status counts the trip in the same transaction
              // as the ledger rows; this route did not, so every delivery the
              // rider app completed left riders.total_trips where it was. Inside
              // the reward guard, so a concurrent second call counts nothing.
              // updateMany, like the RPC's plain UPDATE: no row is a no-op.
              await tx.riders.updateMany({
                where: { id: riderId },
                data: { total_trips: { increment: 1 } },
              });
            }
          }

          return order;
        }),
      'This order changed. Refresh and try again.',
    );

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
        // ready_for_pickup is cancellable only for merchant-less orders,
        // which are born there (MM-4). A food/grocery order reaches it only
        // after the store pressed Mark ready — the food is already cooked.
        OR: [
          { status: order_status.pending },
          { status: order_status.ready_for_pickup, merchant_id: null },
        ],
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
              // S11: rate_order keeps the count beside the average
              // (20260915000200). Recounted from the same aggregate, never
              // incremented, so the two cannot drift apart.
              rating_count: agg._count.merchant_stars,
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
