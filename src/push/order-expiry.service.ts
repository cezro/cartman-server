import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { order_status } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * How long an order may wait for someone to take it before it is cancelled.
 * Owner decision, 2026-10-22: eight hours.
 */
export const EXPIRE_AFTER_HOURS = 8;

/**
 * Who cancelled it. Not a person, so none of the people values
 * (customer / merchant / admin / rider); `canceled_by` is free text with no
 * CHECK constraint, and every client falls back to a neutral line for a value
 * it does not name.
 */
export const EXPIRY_CANCELED_BY = 'system';

/**
 * The reason, per stage it stalled at — the customer reads it on Track, so it
 * says whose step never happened rather than a generic "expired".
 */
const STAGES: ReadonlyArray<{ status: order_status; reason: string }> = [
  {
    status: order_status.pending,
    reason: `The store did not confirm this order within ${EXPIRE_AFTER_HOURS} hours.`,
  },
  {
    status: order_status.preparing,
    reason: `The store did not finish this order within ${EXPIRE_AFTER_HOURS} hours.`,
  },
  {
    status: order_status.ready_for_pickup,
    reason: `No rider was available within ${EXPIRE_AFTER_HOURS} hours.`,
  },
];

/**
 * Retires orders nobody took. Unclaimed orders never left the system before:
 * every booking a customer walked away from sat in the rider feed forever (it
 * has no distance filter, so from every city), and the customer was left on
 * "Finding your rider…" with no end.
 *
 * **Only orders no rider holds.** Once a rider has it, the order is moving or
 * the stall sweep (StalledClaimService) and the stuck notices deal with it —
 * cancelling under a rider who may be carrying the goods is never right.
 *
 * Each stage is one guarded `updateMany`: the WHERE re-checks status and the
 * missing rider in the same statement as the write, so an order claimed or
 * advanced in the same second is left alone. The customer is told by the
 * existing `push_on_order_status` trigger ("Order canceled"), and Realtime
 * clears the card from the panel and the feed.
 */
@Injectable()
export class OrderExpiryService {
  private readonly logger = new Logger(OrderExpiryService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleCron(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error(
        `Order expiry sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async sweep(): Promise<{ expired: number }> {
    const cutoff = new Date(Date.now() - EXPIRE_AFTER_HOURS * 60 * 60_000);
    let expired = 0;

    for (const stage of STAGES) {
      const result = await this.prisma.orders.updateMany({
        where: {
          status: stage.status,
          assigned_rider_id: null,
          created_at: { lt: cutoff },
        },
        data: {
          status: order_status.canceled,
          canceled_by: EXPIRY_CANCELED_BY,
          canceled_reason: stage.reason,
        },
      });
      expired += result.count;
    }

    if (expired > 0) {
      this.logger.log(`Order expiry: ${expired} unclaimed order(s) canceled`);
    }
    return { expired };
  }
}
