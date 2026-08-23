import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { order_status } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How long a claimed-but-unmoved order waits before it goes back to the feed.
 *
 * Shorter than the stuck-notification threshold (15 min) on purpose: the point
 * is to try the cheap automatic fix *before* apologising to the customer. A
 * release moves `updated_at`, so an order that self-heals never trips the
 * stuck sweep at all.
 */
export const RELEASE_AFTER_MINUTES = 10;

/**
 * How many times one order may be auto-released before this stops trying.
 *
 * An order nobody keeps could otherwise cycle claim → stall → release forever,
 * and each lap looks like progress to every other part of the system because
 * `updated_at` keeps moving — which would also keep it permanently invisible
 * to the stuck sweep. After this many laps the problem is the order, not the
 * rider, and it is left alone so a human sees it.
 */
export const MAX_AUTO_RELEASES = 3;

/** How many stalled claims one pass will act on. */
const SWEEP_BATCH = 50;

/**
 * The action recorded in `order_assignment_events`.
 *
 * The column carries a CHECK constraint — `claimed`, `released`,
 * `admin_unassigned`, `admin_canceled` — so a new `auto_released` value is not
 * available without a migration, and migrations live in the other repo and are
 * applied by hand. `admin_unassigned` with a **null `actor_id`** is the honest
 * spelling within that set: the same effect as an admin unassigning, performed
 * by no person. `actor_id` is nullable precisely so it can mean "not a user".
 */
const RELEASE_ACTION = 'admin_unassigned';

const RIDER_EVENT = 'order.released.rider';

/**
 * H17, the acting half — put an abandoned claim back in front of other riders.
 *
 * `StuckOrderService` tells people an order has gone quiet. This is the one
 * case where the fix does not need a human: a rider claimed an order and then
 * did nothing at all — did not reach the store, did not release it. While that
 * claim stands the order is invisible to every other rider, so it cannot be
 * rescued by the ordinary dispatch loop no matter how long anyone waits.
 *
 * **Only `accepted` orders.** The status is the whole safety argument:
 *
 * - `arrived_at_merchant` — the rider is standing in the shop waiting for food.
 *   The store is slow, not the rider, and taking the order off them fixes
 *   nothing while costing them the trip.
 * - `picked_up` / `in_transit` — the rider physically holds the goods.
 *   Releasing would advertise an order in the feed whose food is in somebody
 *   else's bag. This mirrors `rider_release_order`, which refuses after pickup
 *   with "contact support to reassign", and `REASSIGNABLE_STATUSES` in
 *   AdminService.
 *
 * **No cancelling, ever.** That decision is unchanged and deliberate: wallet
 * rows are written at `delivered`, and `admin_cancel_order` refuses a
 * delivered order for that reason. A release has no ledger consequence at all,
 * which is what makes it safe to do automatically and cancelling not.
 *
 * It cannot call `admin_unassign_order` — that RPC opens with
 * `v_uid := auth.uid()` and raises `not authenticated` when it is null, and
 * `auth.uid()` is always null on this server's Prisma connection (PostgREST
 * sets it from a user's JWT; nothing sets it here). The same trap silently
 * cost the rider-verification gate its audit trail. So the release is written
 * here, in one transaction with its audit row.
 */
@Injectable()
export class StalledClaimService {
  private readonly logger = new Logger(StalledClaimService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCron(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error(
        `Stalled-claim sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async sweep(): Promise<{ released: number; skipped: number }> {
    const cutoff = new Date(Date.now() - RELEASE_AFTER_MINUTES * 60_000);

    const stalled = await this.prisma.orders.findMany({
      where: {
        status: order_status.accepted,
        updated_at: { lt: cutoff },
        // An `accepted` order with no rider is not a stalled claim, it is a
        // broken row; releasing it would write an audit line naming nobody.
        assigned_rider_id: { not: null },
      },
      select: { id: true, ref_no: true, assigned_rider_id: true },
      orderBy: { updated_at: 'asc' },
      take: SWEEP_BATCH,
    });
    if (stalled.length === 0) return { released: 0, skipped: 0 };

    // How many laps each of these has already been round. Counted from the
    // audit log rather than a column, so this needs no migration.
    const priorReleases = await this.prisma.order_assignment_events.groupBy({
      by: ['order_id'],
      where: {
        order_id: { in: stalled.map((o) => o.id) },
        action: RELEASE_ACTION,
        // Only the automatic ones. An admin who unassigns an order by hand is
        // making a decision, and it should not count against the budget for
        // the robot's attempts.
        actor_id: null,
      },
      _count: { _all: true },
    });
    const laps = new Map(priorReleases.map((r) => [r.order_id, r._count._all]));

    let released = 0;
    let skipped = 0;

    for (const order of stalled) {
      if ((laps.get(order.id) ?? 0) >= MAX_AUTO_RELEASES) {
        skipped++;
        continue;
      }

      const riderId = order.assigned_rider_id;
      if (!riderId) continue;

      try {
        const didRelease = await this.prisma.$transaction(async (tx) => {
          // Race-safe: the WHERE re-checks the status and the rider in the
          // same statement as the write, so a rider who taps "arrived" in the
          // same second keeps their order rather than losing it mid-tap.
          const result = await tx.orders.updateMany({
            where: {
              id: order.id,
              status: order_status.accepted,
              assigned_rider_id: riderId,
            },
            data: {
              assigned_rider_id: null,
              status: order_status.ready_for_pickup,
            },
          });
          if (result.count === 0) return false;

          await tx.order_assignment_events.create({
            data: {
              order_id: order.id,
              rider_id: riderId,
              action: RELEASE_ACTION,
              reason: `auto-released: claimed but no movement for ${RELEASE_AFTER_MINUTES} minutes`,
              // Null actor = the system. See RELEASE_ACTION above.
              actor_id: null,
            },
          });

          // The rider is told because they may still believe they hold it —
          // an order vanishing from the active screen with no explanation is
          // how a rider learns not to trust the app.
          await tx.push_outbox.create({
            data: {
              user_id: riderId,
              event: RIDER_EVENT,
              title: 'Order returned to the feed',
              body: `${order.ref_no ?? 'An order'} was released because it hadn't moved in ${RELEASE_AFTER_MINUTES} minutes.`,
              data: { order_id: order.id },
            },
          });

          return true;
        });

        if (didRelease) released++;
        else skipped++;
      } catch (err) {
        // One bad row must not cost the rest of the batch its sweep.
        skipped++;
        this.logger.error(
          `Could not release ${order.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (released || skipped) {
      this.logger.log(
        `Stalled-claim sweep: ${released} released, ${skipped} skipped`,
      );
    }
    return { released, skipped };
  }
}
