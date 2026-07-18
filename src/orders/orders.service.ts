import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { order_type, order_status, payment_method } from '@prisma/client';
import { LedgerService } from '../ledger/ledger.service';
import { haversineKm } from './geo';
import { serializeOrder } from './serialize-order';

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

  async placeFoodOrder(customerId: string, data: any) {
    return this.placeMerchantOrder(customerId, data, order_type.food);
  }

  async placeGroceryOrder(customerId: string, data: any) {
    return this.placeMerchantOrder(customerId, data, order_type.grocery);
  }

  private async placeMerchantOrder(
    customerId: string,
    data: any,
    type: typeof order_type.food | typeof order_type.grocery,
  ) {
    const { merchant_id, items } = data;
    if (!items || items.length === 0) {
      throw new BadRequestException('Order must contain items');
    }

    return this.prisma.$transaction(async (tx) => {
      const merchant = await tx.merchants.findUnique({
        where: { id: merchant_id },
      });
      if (!merchant) throw new BadRequestException('Merchant not found');

      let subtotal = 0n;
      const orderItemsData = [];

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
          modifiers: item.modifiers || [],
        });
      }

      const delivery_fee = merchant.delivery_fee;
      const delivery_payout = delivery_fee; // rider gets full delivery fee (v1)
      const total = subtotal + delivery_fee;
      const ref_no = await nextRefNo(tx);

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
    const { errand_payload, notes } = data;
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
}
