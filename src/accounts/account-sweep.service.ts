import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseAdminService } from '../common/supabase-admin.service';

/** How many tombstones one pass will work through. */
const SWEEP_BATCH = 100;

/**
 * L5 — finishes what `delete_my_account()` starts.
 *
 * The RPC tombstones the profile (name → `Deleted user`, phone/avatar nulled,
 * saved addresses erased, store membership dropped, rider un-verified and off
 * duty) and stamps `deleted_at`. What it cannot do is remove the `auth.users`
 * row: that needs the service role, which by design is nowhere near the app.
 * **Until this sweep runs, the credentials still work** — and that is the half
 * an app-store reviewer actually tests (Apple 5.1.1(v), Google Play).
 *
 * The app already signs out on success and on any cold start whose profile
 * carries `deleted_at`, so the window is small; small is not closed.
 *
 * Orders deliberately survive — `orders.customer_id` references the profile
 * with ON DELETE RESTRICT because those rows are the merchant's sales history
 * and the rider's ledger, and PH record-keeping outranks the erasure request.
 * So the tombstone stays and `auth_deleted_at` is what marks a row finished;
 * see 20260807000100 for why nothing else can.
 */
@Injectable()
export class AccountSweepService {
  private readonly logger = new Logger(AccountSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  // Hourly is plenty: the client-side sign-out already closes the common case
  // within seconds, and this is the backstop for a session that never reopens.
  @Cron(CronExpression.EVERY_HOUR)
  async handleCron(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      // A scheduled job that throws takes the process down on some runtimes;
      // an account that fails to sweep must not do that. It is retried next
      // hour regardless, because auth_deleted_at is only stamped on success.
      this.logger.error(
        `Account deletion sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Deletes the auth user behind every tombstoned profile that has not been
   * swept yet. Returns what happened, so the admin route and the tests can
   * assert on it rather than on log output.
   */
  async sweep(): Promise<{ swept: number; failed: number }> {
    const pending = await this.prisma.profiles.findMany({
      where: { deleted_at: { not: null }, auth_deleted_at: null },
      select: { id: true },
      orderBy: { deleted_at: 'asc' },
      take: SWEEP_BATCH,
    });
    if (pending.length === 0) return { swept: 0, failed: 0 };

    let swept = 0;
    let failed = 0;

    for (const { id } of pending) {
      const { error } = await this.supabaseAdmin.deleteUser(id);

      // A user who is already gone is the goal state, not a failure. This
      // happens when a previous run deleted the auth row and then died before
      // stamping, and on any row deleted out of band. Treating it as success
      // is what stops the sweep retrying it every hour forever.
      if (error && !this.isAlreadyGone(error)) {
        failed += 1;
        // The id is a uuid, not a credential, and it is what makes a failure
        // actionable. Nothing about the account's contents is logged.
        this.logger.warn(`Could not delete auth user ${id}: ${error.message}`);
        continue;
      }

      // Stamped only after the auth row is confirmed gone, so a crash between
      // the two leaves the row pending rather than marking it done. Retrying a
      // delete is harmless; skipping one leaves live credentials behind.
      await this.prisma.profiles.update({
        where: { id },
        data: { auth_deleted_at: new Date() },
      });
      swept += 1;
    }

    if (swept > 0 || failed > 0) {
      this.logger.log(
        `Account deletion sweep: ${swept} swept, ${failed} failed`,
      );
    }
    return { swept, failed };
  }

  /** Whether this error means the auth user is already absent. */
  private isAlreadyGone(error: { message: string; status?: number }): boolean {
    if (error.status === 404) return true;
    return /not found/i.test(error.message ?? '');
  }
}
