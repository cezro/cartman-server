import { Logger, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PushDrainService } from './push-drain.service';
import { StuckOrderService } from './stuck-order.service';
import { ArrivalService } from './arrival.service';
import {
  PushSendClient,
  PUSH_SENDER,
  type PushSender,
} from './push-send.client';

/**
 * L3 — the push outbox drainer. No controller: nothing here is
 * client-triggerable, and the only caller is the scheduler (precedent:
 * AccountsModule).
 *
 * The sender is chosen from the environment for the same reason GeoModule
 * chooses its geocoder there — with no service-role key the module still loads
 * and the app still boots, it just has nothing to drain with. **Booting must
 * never require a credential**; a missing one is an ops gap, and refusing to
 * start over it takes the whole API down rather than one feature.
 *
 * (The one deliberate exception to that rule is SEMAPHORE_API_KEY, which
 * *does* refuse to boot in production — because there the held stub returns
 * the OTP in the response body, so degrading is a vulnerability rather than a
 * missing feature. Nothing equivalent is true here: an undrained queue is
 * silent, not unsafe.)
 */
@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: PUSH_SENDER,
      useFactory: (): PushSender | null => {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!url || !key) {
          new Logger('PushModule').warn(
            'Push drain disabled (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset) — ' +
              'push_outbox rows will queue and stay queued.',
          );
          return null;
        }
        return new PushSendClient(url, key);
      },
    },
    PushDrainService,
    // H17 lives here rather than in OrdersModule because what it produces is a
    // push_outbox row — it is a producer for the drainer above, and it changes
    // no order state at all.
    StuckOrderService,
    // H10, same reasoning: it produces push_outbox rows and changes no order
    // state, so it is a producer for the drainer rather than order logic.
    ArrivalService,
  ],
  exports: [PushDrainService, StuckOrderService, ArrivalService],
})
export class PushModule {}
