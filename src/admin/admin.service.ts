import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { order_status, wallet_txn_type } from '@prisma/client';
import { manilaMidnightUtc } from '../common/manila-time';

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
}
