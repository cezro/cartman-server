import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { FcmService } from './fcm.service';
import { WALLET_LOCK_FLOOR } from '../orders/orders.service';

interface OrderWebhookRecord {
  id?: string;
  ref_no?: string | null;
  status?: string;
  customer_id?: string;
  assigned_rider_id?: string | null;
  merchant_name?: string | null;
}

/**
 * Push fan-out for order status changes (cartman-server-endpoints.md §7),
 * driven by the Supabase Database Webhook on `orders`:
 *  - every status change → the customer's devices;
 *  - status changes on an assigned order → that rider's devices;
 *  - `ready_for_pickup` with no rider yet → every on-duty rider that is not
 *    wallet-locked (mirrors the feed/claim gates in OrdersService).
 * Tokens FCM reports as UNREGISTERED/NOT_FOUND are pruned from
 * device_tokens. Per the original brief, this handler must NEVER crash the
 * webhook: missing FCM config degrades to a warned no-op and any push/DB
 * error is logged and swallowed.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly fcmService: FcmService,
  ) {}

  async handleOrderWebhook(payload: unknown) {
    // payload is expected to be a Supabase Database Webhook payload for `orders` table.
    const { type, record, old_record } = (payload ?? {}) as {
      type?: string;
      record?: OrderWebhookRecord | null;
      old_record?: OrderWebhookRecord | null;
    };

    this.logger.log(`Received webhook for order ${record?.id}, type: ${type}`);

    try {
      if (
        type === 'UPDATE' &&
        record &&
        old_record &&
        record.status !== old_record.status
      ) {
        if (!this.fcmService.isConfigured()) {
          this.logger.warn(
            'FCM is not configured (FCM_PROJECT_ID/FCM_CLIENT_EMAIL/FCM_PRIVATE_KEY) — skipping push fan-out',
          );
          return { success: true };
        }

        await this.fanOutStatusChange(record);
      }
    } catch (err) {
      this.logger.error(`Push fan-out failed: ${String(err)}`);
    }

    return { success: true };
  }

  private async fanOutStatusChange(record: OrderWebhookRecord) {
    const status = record.status ?? '';
    const orderLabel = record.ref_no || 'your order';
    const readable = status.replace(/_/g, ' ');
    const data = { order_id: String(record.id ?? ''), status };

    const sends: Promise<void>[] = [];

    if (record.customer_id) {
      sends.push(
        this.notifyUser(
          record.customer_id,
          'Order update',
          `Order ${orderLabel} is now ${readable}`,
          data,
        ),
      );
    }

    if (record.assigned_rider_id) {
      sends.push(
        this.notifyUser(
          record.assigned_rider_id,
          'Order update',
          `Order ${orderLabel} is now ${readable}`,
          data,
        ),
      );
    }

    if (status === 'ready_for_pickup' && !record.assigned_rider_id) {
      const riders = await this.prisma.riders.findMany({
        where: { is_active: true },
      });
      const eligibility = await Promise.all(
        riders.map(async (rider) => ({
          id: rider.id,
          locked:
            (await this.ledgerService.getNetCash(rider.id)) <=
            WALLET_LOCK_FLOOR,
        })),
      );
      for (const rider of eligibility) {
        if (rider.locked) continue;
        sends.push(
          this.notifyUser(
            rider.id,
            'New order available',
            record.merchant_name
              ? `${record.merchant_name} has an order ready for pickup`
              : 'A new order is ready for pickup',
            data,
          ),
        );
      }
    }

    await Promise.all(sends);
  }

  // Sends to every device token of one user; prunes tokens FCM says are
  // dead. A failure on one token never blocks the others.
  private async notifyUser(
    userId: string,
    title: string,
    body: string,
    data: Record<string, string>,
  ): Promise<void> {
    const tokens = await this.prisma.device_tokens.findMany({
      where: { user_id: userId },
    });

    await Promise.all(
      tokens.map(async ({ token }) => {
        try {
          const result = await this.fcmService.sendToToken(
            token,
            { title, body },
            data,
          );
          if (result.unregistered) {
            await this.prisma.device_tokens.deleteMany({
              where: { user_id: userId, token },
            });
          }
        } catch (err) {
          this.logger.warn(`FCM send to user ${userId} failed: ${String(err)}`);
        }
      }),
    );
  }
}
