import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TERMINAL_ORDER_STATUSES } from '../orders/orders.service';

/**
 * How long an order may sit with no change before it counts as stuck. Long
 * enough that a busy-but-normal order does not trip it, short enough that the
 * customer hears from us before they give up and call.
 */
const STUCK_AFTER_MINUTES = 15;

/** How many stuck orders one pass will report on. */
const SWEEP_BATCH = 100;

/** The customer's copy — an apology. */
const CUSTOMER_EVENT = 'order.stuck';
/** The admin's copy — a work item. */
const ADMIN_EVENT = 'order.stuck.admin';

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
    const cutoff = new Date(Date.now() - STUCK_AFTER_MINUTES * 60_000);

    const candidates = await this.prisma.orders.findMany({
      where: {
        // A deny-list of terminal statuses, not an allow-list of live ones: a
        // new status joins "live" by default rather than silently escaping the
        // sweep. This repo already shipped the inverse bug — three guards spelt
        // the terminal set as `notIn: [delivered, canceled]`, so
        // `delivery_failed` counted as an active order everywhere.
        status: { notIn: TERMINAL_ORDER_STATUSES },
        updated_at: { lt: cutoff },
      },
      select: { id: true, ref_no: true, customer_id: true },
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
      return [
        {
          user_id: o.customer_id,
          event: CUSTOMER_EVENT,
          title: 'Still looking for a rider',
          body: `${ref} is taking longer than usual. We're on it.`,
          data: { order_id: o.id },
        },
        // Every admin, not the first one. Approvals are already pull-only and
        // nothing else tells anyone a store is waiting; a queue with one
        // notified admin who is asleep is the same as no queue.
        ...admins.map((a) => ({
          user_id: a.id,
          event: ADMIN_EVENT,
          title: 'Order stuck',
          body: `${ref} has not moved in ${STUCK_AFTER_MINUTES} minutes.`,
          data: { order_id: o.id },
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
