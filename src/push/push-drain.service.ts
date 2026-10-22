import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PUSH_SENDER, type PushSender } from './push-send.client';

/** How many rows one pass will work through. Matches the migration's own note. */
const DRAIN_BATCH = 50;

/**
 * How many times a row is retried before it is left alone. A row that has
 * failed five times is failing for a reason a sixth attempt will not fix, and
 * `last_error` is what says why.
 */
const MAX_ATTEMPTS = 5;

/**
 * L3 — the drainer. The last piece of code between the queue and a phone.
 *
 * `20260810000200_push_outbox.sql` gave the database six triggers that decide
 * *who* to notify and write a row; `push-send` has done a real FCM HTTP v1 send
 * for weeks. Nothing joined the two, so every notification in the system has
 * been queued and then ignored. This reads the queue and posts each row.
 *
 * It lives here rather than as pg_cron + pg_net because this codebase already
 * holds the service-role key that `push-send` requires — the alternative puts
 * that key in a migration, which is to say in git.
 *
 * **A stamped row is never read again**, so the one thing this must never do is
 * stamp a row it did not actually deliver. That is the same failure the POD
 * write had: a write that matched zero rows and reported success.
 */
@Injectable()
export class PushDrainService {
  private readonly logger = new Logger(PushDrainService.name);

  /**
   * Guards against overlapping passes. The poll interval is far shorter than a
   * batch of 50 HTTP sends can take, and a second pass would read the same
   * not-yet-stamped rows and send every one of them a second time.
   *
   * **This is an instance field, so it guards passes within one process — and
   * that means one instance is currently load-bearing.** `render.yaml` declares
   * `plan: standard` with no `numInstances`; the day someone scales to two,
   * both replicas run this sweep over the same rows and every notification goes
   * out twice until `sent_at` lands. The same applies to ArrivalService and
   * StuckOrderService, which read-then-`createMany` with no guard between.
   * (StalledClaimService is safe: its conditional `updateMany` means only one
   * writer wins.)
   *
   * Making it structural is a few lines — `pg_try_advisory_lock` on a
   * per-sweeper key, released in the same `finally` that clears this flag, on
   * the connection we already hold. Until then the constraint is recorded here
   * and beside `plan:` in `render.yaml`, because it is invisible at exactly the
   * moment someone would violate it: under load, when scaling up is the obvious
   * move.
   */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(PUSH_SENDER) private readonly sender: PushSender | null,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async handleCron(): Promise<void> {
    try {
      await this.drain();
    } catch (err) {
      // A scheduled job that throws takes the process down on some runtimes. A
      // notification that cannot be sent must not do that; the rows keep their
      // `sent_at is null` and the next pass picks them up.
      this.logger.error(
        `Push drain failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Sends every pending notification it can, and reports what happened so the
   * tests assert on behaviour rather than on log output.
   */
  async drain(): Promise<{ sent: number; failed: number }> {
    // Booting must never require the service-role key (GeoModule sets the same
    // precedent for MAPBOX_TOKEN). Polling a queue we have no way to drain
    // would be pure log noise, so this returns before touching the database.
    if (!this.sender) return { sent: 0, failed: 0 };
    if (this.running) return { sent: 0, failed: 0 };
    this.running = true;

    try {
      const pending = await this.prisma.push_outbox.findMany({
        where: { sent_at: null, attempts: { lt: MAX_ATTEMPTS } },
        select: {
          id: true,
          user_id: true,
          event: true,
          title: true,
          body: true,
          data: true,
          attempts: true,
        },
        orderBy: { created_at: 'asc' },
        take: DRAIN_BATCH,
      });
      if (pending.length === 0) return { sent: 0, failed: 0 };

      let sent = 0;
      let failed = 0;

      for (const row of pending) {
        const result = await this.trySend(row);

        if (result.ok) {
          // Stamped only after the send is confirmed accepted, so a crash
          // between the two leaves the row pending rather than marking it
          // done. A re-sent notification is a duplicate buzz; a wrongly
          // stamped one is silence forever.
          //
          // `last_error` is cleared in the same write because this is the only
          // moment anything can clear it — a stamped row is never selected
          // again, so an error left behind here describes the row forever and
          // the queue reads as broken long after it healed.
          await this.prisma.push_outbox.update({
            where: { id: row.id },
            data: { sent_at: new Date(), last_error: null },
          });
          sent += 1;
          continue;
        }

        // Counted up from what the row carries, not from zero — otherwise
        // `attempts` never reaches MAX_ATTEMPTS and a permanently dead row is
        // retried every ten seconds for the life of the deployment.
        await this.prisma.push_outbox.update({
          where: { id: row.id },
          data: { attempts: row.attempts + 1, last_error: result.error },
        });
        failed += 1;
      }

      if (sent > 0 || failed > 0) {
        this.logger.log(`Push drain: ${sent} sent, ${failed} failed`);
      }
      return { sent, failed };
    } finally {
      // Released in a finally, or a single failed pass wedges the drainer for
      // the life of the process and nothing says why.
      this.running = false;
    }
  }

  /** Turns a thrown send (socket reset, timeout) into the same shape as a 5xx. */
  private async trySend(row: {
    user_id: string;
    event: string;
    title: string;
    body: string | null;
    data: unknown;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      return await this.sender!.send({
        user_id: row.user_id,
        title: row.title,
        body: row.body,
        // The event name rides in the data payload: the apps route on it
        // (PushMessage.event — `rider.approved` re-checks approval and opens
        // the feed). It was dropped here, so that handling never fired.
        data: {
          ...(row.data && typeof row.data === 'object' ? row.data : {}),
          event: row.event,
        },
      });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
