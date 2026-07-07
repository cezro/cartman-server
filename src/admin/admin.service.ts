import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { order_status, wallet_txn_type } from '@prisma/client';
import { manilaMidnightUtc } from '../common/manila-time';
import { serializeOrder } from '../orders/serialize-order';
import { AdminOrdersQueryDto } from './dto/admin.dto';

const CUSTOMER_SELECT = { id: true, full_name: true, phone: true } as const;
const RIDER_SELECT = { id: true, full_name: true, phone: true } as const;

// Mirrors LedgerService's private CREDIT_TYPES (src/ledger/ledger.service.ts)
// — duplicated rather than imported/exported so this module stays a pure
// reader of the ledger, same precedent as OrdersService.WALLET_LOCK_FLOOR
// mirroring LedgerService's LOCK_FLOOR. Keep these two lists in sync.
const CREDIT_TYPES: wallet_txn_type[] = [
  'credit_remittance',
  'credit_delivery_reward',
];

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getStats() {
    const midnight = manilaMidnightUtc();

    const [
      active,
      unassigned,
      deliveredToday,
      canceledToday,
      onDuty,
      total,
      codTodayRows,
      netCashRows,
      deliveredTodayOrders,
    ] = await Promise.all([
      this.prisma.orders.count({
        where: {
          status: { notIn: [order_status.delivered, order_status.canceled] },
        },
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
        select: { created_at: true, updated_at: true },
      }),
    ]);

    const codExpected =
      codTodayRows.find(
        (r: { type: string }) => r.type === 'debit_cod_order',
      )?._sum.amount ?? 0n;
    const codRemitted =
      codTodayRows.find(
        (r: { type: string }) => r.type === 'credit_remittance',
      )?._sum.amount ?? 0n;

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

    // Approximation pending a delivered_at column — updated_at is bumped by
    // the orders_set_updated_at DB trigger and delivered rows are not
    // mutated afterward today, so (updated_at - created_at) on a delivered
    // row is currently equivalent to its delivery duration.
    let avgDeliverySecsToday: number | null = null;
    if (deliveredTodayOrders.length > 0) {
      const totalSecs = (
        deliveredTodayOrders as { created_at: Date; updated_at: Date }[]
      ).reduce(
        (sum, o) =>
          sum + (o.updated_at.getTime() - o.created_at.getTime()) / 1000,
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

    let riderExtra: { vehicle: string; plate_no: string; rating: number } | null =
      null;
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
        (order as Record<string, any>).rider && riderExtra
          ? { ...(order as Record<string, any>).rider, ...riderExtra }
          : ((order as Record<string, any>).rider ?? null),
      last_location: lastLocation,
      ledger_entries: ledgerTxns.map(
        (t: { id: bigint; type: string; amount: bigint; created_at: Date }) => ({
          id: t.id.toString(),
          type: t.type,
          amount: t.amount.toString(),
          created_at: t.created_at,
        }),
      ),
    };
  }
}
