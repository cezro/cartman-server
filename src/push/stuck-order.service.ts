import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { order_status } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TERMINAL_ORDER_STATUSES } from '../orders/orders.service';

/**
 * How long an order may sit with no change before it counts as stuck. Long
 * enough that a busy-but-normal order does not trip it, short enough that the
 * customer hears from us before they give up and call.
 */
export const STUCK_AFTER_MINUTES = 15;

/**
 * The same, for an order a rider is physically carrying.
 *
 * `orders_set_updated_at` fires on UPDATE, so `updated_at` moves only when the
 * row changes — that is, on a status transition. Nothing writes to the row
 * during the drive itself: `rider_locations` is a separate table. So a
 * perfectly healthy 25-minute cross-town delivery has an `updated_at` frozen
 * at the moment it went `in_transit`, and at the 15-minute mark it looks
 * exactly like an abandoned one.
 *
 * A delivery leg is quiet by nature, so it gets a threshold that reflects how
 * long deliveries actually take rather than how long a queue should wait.
 */
export const CARRYING_STUCK_AFTER_MINUTES = 40;

/** Statuses in which a rider physically holds the goods. */
const CARRYING_STATUSES: order_status[] = [
  order_status.picked_up,
  order_status.in_transit,
];

/** How many stuck orders one pass will report on. */
const SWEEP_BATCH = 100;

/** The customer's copy — an apology. */
const CUSTOMER_EVENT = 'order.stuck';
/** The admin's copy — a work item. */
const ADMIN_EVENT = 'order.stuck.admin';

/**
 * What to tell the customer, chosen by where the order actually is.
 *
 * This used to be one sentence for every stuck order: "Still looking for a
 * rider." That is true only at `ready_for_pickup`. Sent to someone whose rider
 * is five minutes from their door it is not merely unhelpful, it is wrong in
 * the direction that generates the support call it was written to prevent —
 * the customer now believes nobody has even picked their order up.
 *
 * Each line says which of the three parties everyone is waiting on, because
 * that is the only thing the customer can act on (wait, call the store, or
 * call us).
 */
function customerCopy(
  status: order_status,
  ref: string,
): { title: string; body: string } {
  switch (status) {
    case order_status.pending:
      return {
        title: 'Still confirming your order',
        body: `${ref} is waiting for the store to confirm it. We're on it.`,
      };
    case order_status.preparing:
      return {
        title: 'Your order is taking longer',
        body: `${ref} is still being prepared. We're on it.`,
      };
    case order_status.ready_for_pickup:
      return {
        title: 'Still looking for a rider',
        body: `${ref} is ready and we're still finding a rider for it.`,
      };
    case order_status.accepted:
    case order_status.arrived_at_merchant:
      return {
        title: 'Your rider is running late',
        body: `${ref} has a rider assigned, but it hasn't moved. We're on it.`,
      };
    default:
      // picked_up / in_transit — and anything added later, which is the safe
      // way round: a new status reads as "late" rather than as "no rider".
      return {
        title: 'Your delivery is running late',
        body: `${ref} is on its way but taking longer than usual.`,
      };
  }
}

/**
 * H17 — the half of stuck-order handling that happens without a human looking.
 *
 * The admin console already surfaces orders whose `updated_at` has not moved
 * (I14), and `admin_unassign_order` / `admin_cancel_order` let an admin act.
 * But nothing fires on its own, and **the customer is never told** — they watch
 * a tracking screen that does not change, which is what generates the support
 * call.
 *
 * This deliberately changes **no order state**. Auto-cancelling an order a
 * merchant has already cooked is a worse failure than a slow one, and the
 * wallet rows are written at `delivered`, so a cancel has ledger consequences
 * that a notification does not. It writes `push_outbox` rows and stops; the
 * drainer delivers them and a human still decides.
 *
 * (The one automatic *action* in H17 lives in `StalledClaimService`, which
 * releases a claim that never went anywhere back to the feed. That is a
 * separate service on purpose — this one's contract is that it is safe
 * precisely because it cannot change anything.)
 *
 * A scheduled job rather than a trigger, because "nothing has happened for 15
 * minutes" is not an event the database can fire on.
 */
@Injectable()
export class StuckOrderService {
  private readonly logger = new Logger(StuckOrderService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Every 5 minutes: a third of the stuck threshold, so an order is reported
  // within ~20 minutes of going quiet without polling for its own sake.
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCron(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error(
        `Stuck-order sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async sweep(): Promise<{ stuck: number; notified: number }> {
    const now = Date.now();
    const cutoff = new Date(now - STUCK_AFTER_MINUTES * 60_000);
    const carryingCutoff = new Date(
      now - CARRYING_STUCK_AFTER_MINUTES * 60_000,
    );

    const candidates = await this.prisma.orders.findMany({
      where: {
        // A deny-list of terminal statuses, not an allow-list of live ones: a
        // new status joins "live" by default rather than silently escaping the
        // sweep. This repo already shipped the inverse bug — three guards spelt
        // the terminal set as `notIn: [delivered, canceled]`, so
        // `delivery_failed` counted as an active order everywhere.
        status: { notIn: TERMINAL_ORDER_STATUSES },
        // Two clocks, because a rider mid-drive updates nothing on the row and
        // would otherwise be indistinguishable from an abandoned order.
        OR: [
          {
            status: { in: CARRYING_STATUSES },
            updated_at: { lt: carryingCutoff },
          },
          {
            status: {
              notIn: [...TERMINAL_ORDER_STATUSES, ...CARRYING_STATUSES],
            },
            updated_at: { lt: cutoff },
          },
        ],
      },
      select: {
        id: true,
        ref_no: true,
        customer_id: true,
        status: true,
        updated_at: true,
      },
      orderBy: { updated_at: 'asc' },
      take: SWEEP_BATCH,
    });
    if (candidates.length === 0) return { stuck: 0, notified: 0 };

    // `push_outbox` is its own record of what has been announced, so this
    // needs no new column and no migration — which matters, because migrations
    // live in the other repo and are applied by hand.
    const announced = await this.prisma.push_outbox.findMany({
      where: {
        event: CUSTOMER_EVENT,
        user_id: { in: candidates.map((o) => o.customer_id) },
      },
      select: { data: true },
    });
    const seen = new Set(
      announced
        .map((r) => (r.data as { order_id?: string } | null)?.order_id)
        .filter((id): id is string => typeof id === 'string'),
    );

    const fresh = candidates.filter((o) => !seen.has(o.id));
    if (fresh.length === 0) return { stuck: 0, notified: 0 };

    const admins = await this.prisma.profiles.findMany({
      where: { role: 'admin', deleted_at: null },
      select: { id: true },
    });

    const rows = fresh.flatMap((o) => {
      const ref = o.ref_no ?? '';
      const quietFor = Math.round((now - o.updated_at.getTime()) / 60_000);
      return [
        {
          user_id: o.customer_id,
          event: CUSTOMER_EVENT,
          ...customerCopy(o.status, ref),
          data: { order_id: o.id },
        },
        // Every admin, not the first one. Approvals are already pull-only and
        // nothing else tells anyone a store is waiting; a queue with one
        // notified admin who is asleep is the same as no queue.
        //
        // The admin line carries the status and the real elapsed time, not the
        // threshold — "has not moved in 15 minutes" on an order that has been
        // quiet for two hours reads as a fresh problem and buries the old one.
        ...admins.map((a) => ({
          user_id: a.id,
          event: ADMIN_EVENT,
          title: 'Order stuck',
          body: `${ref} has been ${o.status} with no change for ${quietFor} minutes.`,
          data: { order_id: o.id, status: o.status, quiet_minutes: quietFor },
        })),
      ];
    });

    await this.prisma.push_outbox.createMany({ data: rows });

    this.logger.log(
      `Stuck-order sweep: ${fresh.length} stuck, ${rows.length} notified`,
    );
    return { stuck: fresh.length, notified: rows.length };
  }
}
