import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { order_status, wallet_txn_type } from '@prisma/client';
import { manilaMidnightUtc } from '../common/manila-time';
import { serializeOrder } from '../orders/serialize-order';
import {
  AdminOrdersQueryDto,
  AdminRidersQueryDto,
  AdminMerchantsQueryDto,
  AdminLedgerQueryDto,
} from './dto/admin.dto';
import { LedgerService, CREDIT_TYPES } from '../ledger/ledger.service';
import {
  ACTIVE_RIDER_STATUSES,
  MAX_ACTIVE_ORDERS_PER_RIDER,
  TERMINAL_ORDER_STATUSES,
  WALLET_LOCK_FLOOR,
} from '../orders/orders.service';
import {
  serializeAdminRider,
  serializeAdminMerchant,
  serializeAdminLedgerTxn,
} from './serialize-admin';

// Statuses from which an admin may reassign an order to a different rider —
// once a rider has physically picked the order up, reassigning stops making
// sense (mirrors the rider-driven forward-progression invariants in
// orders.service.ts's NEXT map).
const REASSIGNABLE_STATUSES: order_status[] = [
  order_status.ready_for_pickup,
  order_status.accepted,
  order_status.arrived_at_merchant,
];

const CUSTOMER_SELECT = { id: true, full_name: true, phone: true } as const;
const RIDER_SELECT = { id: true, full_name: true, phone: true } as const;

// Same "active" definition as GET /admin/stats's orders.active (everything
// except the terminal statuses) — reused for the per-merchant and per-rider
// active_orders counts on the fleet/merchant list endpoints. Derived from the
// one TERMINAL_ORDER_STATUSES list so a new terminal status cannot quietly
// start counting as active here.
const NON_TERMINAL_ORDER_STATUSES: order_status[] = Object.values(
  order_status,
).filter((s) => !TERMINAL_ORDER_STATUSES.includes(s));

// Ledger sign rule imported from LedgerService — one definition; see the
// export comment there for the SQL-function sync requirement.

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
  ) {}

  async getStats() {
    const midnight = manilaMidnightUtc();

    const [
      active,
      unassigned,
      deliveredToday,
      canceledToday,
      deliveryFailedToday,
      onDuty,
      total,
      codTodayRows,
      netCashRows,
      deliveredTodayOrders,
    ] = await Promise.all([
      this.prisma.orders.count({
        where: { status: { notIn: TERMINAL_ORDER_STATUSES } },
      }),
      this.prisma.orders.count({
        where: {
          status: order_status.ready_for_pickup,
          assigned_rider_id: null,
        },
      }),
      this.prisma.orders.count({
        where: {
          status: order_status.delivered,
          updated_at: { gte: midnight },
        },
      }),
      this.prisma.orders.count({
        where: {
          status: order_status.canceled,
          updated_at: { gte: midnight },
        },
      }),
      // Counted separately from canceled_today, and on delivery_failed_at
      // rather than updated_at: the failure time is the server clock stamped
      // by the RPC, so it survives any later touch of the row (an ops note, a
      // refund flag) that would drag updated_at into tomorrow.
      this.prisma.orders.count({
        where: {
          status: order_status.delivery_failed,
          delivery_failed_at: { gte: midnight },
        },
      }),
      this.prisma.riders.count({ where: { is_active: true } }),
      this.prisma.riders.count(),
      // Single groupBy for today's COD roll-up (expected vs remitted) —
      // not per-rider, so no N+1 risk here.
      this.prisma.rider_wallet_transactions.groupBy({
        by: ['type'],
        where: {
          type: { in: ['debit_cod_order', 'credit_remittance'] },
          created_at: { gte: midnight },
        },
        _sum: { amount: true },
      }),
      // Single groupBy for ALL-time net cash per rider — folded in memory
      // below with the CREDIT/DEBIT sign rule. NEVER loop getNetCash per
      // rider; that would be one query per rider instead of one total.
      this.prisma.rider_wallet_transactions.groupBy({
        by: ['rider_id', 'type'],
        _sum: { amount: true },
      }),
      this.prisma.orders.findMany({
        where: {
          status: order_status.delivered,
          updated_at: { gte: midnight },
        },
        select: { created_at: true, updated_at: true, delivered_at: true },
      }),
    ]);

    const codExpected =
      codTodayRows.find((r: { type: string }) => r.type === 'debit_cod_order')
        ?._sum.amount ?? 0n;
    const codRemitted =
      codTodayRows.find((r: { type: string }) => r.type === 'credit_remittance')
        ?._sum.amount ?? 0n;

    const netByRider = new Map<string, bigint>();
    for (const row of netCashRows as {
      rider_id: string;
      type: wallet_txn_type;
      _sum: { amount: bigint | null };
    }[]) {
      const amount = row._sum.amount ?? 0n;
      const signed = CREDIT_TYPES.includes(row.type) ? amount : -amount;
      netByRider.set(
        row.rider_id,
        (netByRider.get(row.rider_id) ?? 0n) + signed,
      );
    }

    let ridersOwing = 0;
    let outstandingTotal = 0n;
    for (const net of netByRider.values()) {
      if (net < 0n) {
        ridersOwing += 1;
        outstandingTotal += -net;
      }
    }

    // Prefer `delivered_at` — the server clock stamped on the actual
    // in_transit → delivered transition — and fall back to `updated_at` only
    // where it is null.
    //
    // The fallback is not permanent politeness: rows delivered before
    // 20260803000300 added the column never got one, and neither did any
    // delivery completed through this server before it started stamping it.
    // Dropping those rows would silently narrow the average to a subset
    // instead of reporting it over the day.
    //
    // `updated_at` alone is no longer a safe stand-in, whatever the previous
    // comment here claimed: rider_submit_pod writes the proof-of-delivery
    // photo *after* the handover and bumps `updated_at` with it, so on any
    // order with a POD the old arithmetic measured order-to-paperwork rather
    // than order-to-doorstep.
    let avgDeliverySecsToday: number | null = null;
    if (deliveredTodayOrders.length > 0) {
      const totalSecs = (
        deliveredTodayOrders as {
          created_at: Date;
          updated_at: Date;
          delivered_at: Date | null;
        }[]
      ).reduce(
        (sum, o) =>
          sum +
          ((o.delivered_at ?? o.updated_at).getTime() -
            o.created_at.getTime()) /
            1000,
        0,
      );
      avgDeliverySecsToday = totalSecs / deliveredTodayOrders.length;
    }

    return {
      orders: {
        active,
        unassigned,
        delivered_today: deliveredToday,
        canceled_today: canceledToday,
        delivery_failed_today: deliveryFailedToday,
      },
      fleet: { on_duty: onDuty, total },
      cod_today: {
        expected: Number(codExpected),
        remitted: Number(codRemitted),
      },
      remittance: {
        riders_owing: ridersOwing,
        outstanding_total: Number(outstandingTotal),
      },
      avg_delivery_secs_today: avgDeliverySecsToday,
    };
  }

  async getOrders(query: AdminOrdersQueryDto) {
    const { limit, offset, status, type, rider_id, customer_id, merchant_id } =
      query;

    const where: Record<string, unknown> = {};
    if (status?.length) where.status = { in: status };
    if (type) where.type = type;
    if (rider_id) where.assigned_rider_id = rider_id;
    if (customer_id) where.customer_id = customer_id;
    if (merchant_id) where.merchant_id = merchant_id;

    const [orders, total] = await Promise.all([
      this.prisma.orders.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        skip: offset,
        include: {
          customer: { select: CUSTOMER_SELECT },
          rider: { select: RIDER_SELECT },
        },
      }),
      this.prisma.orders.count({ where }),
    ]);

    return {
      items: orders.map((order: Record<string, any>) => serializeOrder(order)),
      total,
      limit,
      offset,
    };
  }

  async getOrderById(id: string) {
    const order = await this.prisma.orders.findUnique({
      where: { id },
      include: {
        order_items: true,
        order_stops: true,
        customer: { select: CUSTOMER_SELECT },
        rider: { select: RIDER_SELECT },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    let riderExtra: {
      vehicle: string;
      plate_no: string;
      rating: number;
    } | null = null;
    let lastLocation: { lat: number; lng: number; recorded_at: Date } | null =
      null;

    if (order.assigned_rider_id) {
      const [riderRow, lastLoc] = await Promise.all([
        this.prisma.riders.findUnique({
          where: { id: order.assigned_rider_id },
        }),
        this.prisma.rider_locations.findFirst({
          where: { rider_id: order.assigned_rider_id },
          orderBy: { recorded_at: 'desc' },
        }),
      ]);

      if (riderRow) {
        riderExtra = {
          vehicle: riderRow.vehicle,
          plate_no: riderRow.plate_no,
          rating: Number(riderRow.rating),
        };
      }
      if (lastLoc) {
        lastLocation = {
          lat: lastLoc.lat,
          lng: lastLoc.lng,
          recorded_at: lastLoc.recorded_at,
        };
      }
    }

    const ledgerTxns = await this.prisma.rider_wallet_transactions.findMany({
      where: { order_id: id },
    });

    return {
      ...serializeOrder(order as Record<string, any>),
      rider:
        order.rider && riderExtra
          ? { ...order.rider, ...riderExtra }
          : (order.rider ?? null),
      last_location: lastLocation,
      ledger_entries: ledgerTxns.map(
        (t: {
          id: bigint;
          type: string;
          amount: bigint;
          created_at: Date;
        }) => ({
          id: t.id.toString(),
          type: t.type,
          amount: t.amount.toString(),
          created_at: t.created_at,
        }),
      ),
    };
  }

  async cancelOrder(id: string) {
    // Race-safe: the WHERE clause re-checks the terminal-status guard
    // atomically in the same statement as the write, so a concurrent
    // cancel/delivery can't both "succeed".
    //
    // `delivery_failed` is in that guard, so a failed delivery cannot be
    // overwritten with `canceled`. That would leave an incoherent row — status
    // `canceled` still carrying `delivery_failure_reason` and
    // `delivery_failed_at` — and would erase the distinction the failure state
    // exists to record: whether the goods moved, and who is holding them.
    const result = await this.prisma.orders.updateMany({
      where: {
        id,
        status: { notIn: TERMINAL_ORDER_STATUSES },
      },
      data: { status: order_status.canceled },
    });

    if (result.count === 0) {
      const existing = await this.prisma.orders.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Order not found');
      throw new BadRequestException('Order can no longer be canceled');
    }

    const order = await this.prisma.orders.findUnique({ where: { id } });
    return serializeOrder(order as Record<string, any>);
  }

  async reassignOrder(id: string, riderId: string) {
    const order = await this.prisma.orders.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Order not found');

    const rider = await this.prisma.riders.findUnique({
      where: { id: riderId },
    });
    if (!rider?.is_active) {
      throw new BadRequestException('Rider does not exist or is not active');
    }

    const netCash = await this.ledgerService.getNetCash(riderId);
    if (netCash <= WALLET_LOCK_FLOOR) {
      throw new BadRequestException(
        'Rider wallet is locked — cannot accept orders',
      );
    }

    const activeCount = await this.prisma.orders.count({
      where: {
        assigned_rider_id: riderId,
        status: { in: ACTIVE_RIDER_STATUSES },
      },
    });
    if (activeCount >= MAX_ACTIVE_ORDERS_PER_RIDER) {
      throw new BadRequestException(
        'Rider already has a full active order queue',
      );
    }

    if (riderId === (order as Record<string, any>).assigned_rider_id) {
      throw new BadRequestException('Order is already assigned to this rider');
    }

    // Race-safe: the WHERE clause re-checks the order is still in a
    // reassignable status atomically in the same statement as the write.
    const result = await this.prisma.orders.updateMany({
      where: { id, status: { in: REASSIGNABLE_STATUSES } },
      data: { assigned_rider_id: riderId, status: order_status.accepted },
    });

    if (result.count === 0) {
      const existing = await this.prisma.orders.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Order not found');
      throw new BadRequestException('Order can no longer be reassigned');
    }

    const updated = await this.prisma.orders.findUnique({ where: { id } });
    return serializeOrder(updated as Record<string, any>);
  }

  async getRiders(query: AdminRidersQueryDto) {
    const { limit, offset, on_duty } = query;
    const where: Record<string, unknown> = {};
    if (on_duty !== undefined) where.is_active = on_duty;

    const [riders, total] = await Promise.all([
      this.prisma.riders.findMany({
        where,
        take: limit,
        skip: offset,
        include: { profile: { select: { full_name: true, phone: true } } },
      }),
      this.prisma.riders.count({ where }),
    ]);

    const riderIds = riders.map((r: { id: string }) => r.id);

    // Three batch queries total, regardless of how many riders are on this
    // page — NO per-rider looping.
    const [activeCountRows, netCashRows, lastLocationRows] =
      riderIds.length === 0
        ? [[], [], []]
        : await Promise.all([
            this.prisma.orders.groupBy({
              by: ['assigned_rider_id'],
              where: {
                assigned_rider_id: { in: riderIds },
                status: { in: ACTIVE_RIDER_STATUSES },
              },
              _count: { _all: true },
            }),
            this.prisma.rider_wallet_transactions.groupBy({
              by: ['rider_id', 'type'],
              where: { rider_id: { in: riderIds } },
              _sum: { amount: true },
            }),
            this.prisma.rider_locations.findMany({
              where: { rider_id: { in: riderIds } },
              distinct: ['rider_id'],
              orderBy: { recorded_at: 'desc' },
            }),
          ]);

    const activeCountByRider = new Map<string, number>();
    for (const row of activeCountRows as {
      assigned_rider_id: string | null;
      _count: { _all: number };
    }[]) {
      if (row.assigned_rider_id) {
        activeCountByRider.set(row.assigned_rider_id, row._count._all);
      }
    }

    const netCashByRider = new Map<string, bigint>();
    for (const row of netCashRows as {
      rider_id: string;
      type: wallet_txn_type;
      _sum: { amount: bigint | null };
    }[]) {
      const amount = row._sum.amount ?? 0n;
      const signed = CREDIT_TYPES.includes(row.type) ? amount : -amount;
      netCashByRider.set(
        row.rider_id,
        (netCashByRider.get(row.rider_id) ?? 0n) + signed,
      );
    }

    const lastLocationByRider = new Map<
      string,
      { lat: number; lng: number; recorded_at: Date }
    >();
    for (const loc of lastLocationRows as {
      rider_id: string;
      lat: number;
      lng: number;
      recorded_at: Date;
    }[]) {
      // rider_locations.findMany with distinct:['rider_id'] + orderBy
      // recorded_at desc gives exactly the latest row per rider already, so
      // the first occurrence per rider_id here is the last known location.
      if (!lastLocationByRider.has(loc.rider_id)) {
        lastLocationByRider.set(loc.rider_id, {
          lat: loc.lat,
          lng: loc.lng,
          recorded_at: loc.recorded_at,
        });
      }
    }

    const floor = Number(WALLET_LOCK_FLOOR);

    const items = riders.map((r) => {
      const netCash = netCashByRider.get(r.id) ?? 0n;
      return serializeAdminRider({
        id: r.id,
        full_name: r.profile?.full_name ?? '',
        phone: r.profile?.phone ?? null,
        is_active: r.is_active,
        vehicle: r.vehicle,
        plate_no: r.plate_no,
        rating: r.rating,
        acceptance_rate: r.acceptance_rate,
        total_trips: r.total_trips,
        active_orders: activeCountByRider.get(r.id) ?? 0,
        net_cash: netCash,
        wallet_locked: Number(netCash) <= floor,
        last_location: lastLocationByRider.get(r.id) ?? null,
      });
    });

    return { items, total, limit, offset };
  }

  async getMerchants(query: AdminMerchantsQueryDto) {
    const { limit, offset, is_open } = query;
    const where: Record<string, unknown> = {};
    if (is_open !== undefined) where.is_open = is_open;

    const [merchants, total] = await Promise.all([
      this.prisma.merchants.findMany({ where, take: limit, skip: offset }),
      this.prisma.merchants.count({ where }),
    ]);

    const merchantIds = merchants.map((m: { id: string }) => m.id);

    const activeCountRows = merchantIds.length
      ? await this.prisma.orders.groupBy({
          by: ['merchant_id'],
          where: {
            merchant_id: { in: merchantIds },
            status: { in: NON_TERMINAL_ORDER_STATUSES },
          },
          _count: { _all: true },
        })
      : [];

    const activeCountByMerchant = new Map<string, number>();
    for (const row of activeCountRows as {
      merchant_id: string | null;
      _count: { _all: number };
    }[]) {
      if (row.merchant_id) {
        activeCountByMerchant.set(row.merchant_id, row._count._all);
      }
    }

    const items = merchants.map((m) =>
      serializeAdminMerchant({
        ...m,
        active_orders: activeCountByMerchant.get(m.id) ?? 0,
      }),
    );

    return { items, total, limit, offset };
  }

  async getLedgerTransactions(query: AdminLedgerQueryDto) {
    const { limit, offset, rider_id, order_id, type } = query;
    const where: Record<string, unknown> = {};
    if (rider_id) where.rider_id = rider_id;
    if (order_id) where.order_id = order_id;
    if (type) where.type = type;

    const [txns, total] = await Promise.all([
      this.prisma.rider_wallet_transactions.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        skip: offset,
        include: {
          rider: { include: { profile: { select: { full_name: true } } } },
        },
      }),
      this.prisma.rider_wallet_transactions.count({ where }),
    ]);

    const items = (
      txns as {
        id: bigint;
        rider_id: string;
        type: wallet_txn_type;
        amount: bigint;
        order_id: string | null;
        created_at: Date;
        rider?: { profile?: { full_name: string } };
      }[]
    ).map((t) =>
      serializeAdminLedgerTxn({
        id: t.id,
        rider_id: t.rider_id,
        rider_name: t.rider?.profile?.full_name ?? '',
        type: t.type,
        amount: t.amount,
        order_id: t.order_id,
        created_at: t.created_at,
      }),
    );

    return { items, total, limit, offset };
  }
}
