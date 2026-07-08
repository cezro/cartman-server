import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  /**
   * FCM fan-out is currently a **stub**: it only logs what it would send.
   * There is no `device_tokens` lookup, no firebase-admin (or any) SDK call,
   * no fan-out to on-duty riders for `ready_for_pickup`, and no
   * wallet-lockout exclusion — those all remain to be built. This guard only
   * ensures that, once real sending is added behind these env vars, a
   * missing FCM config degrades to a warned no-op instead of a webhook 500 —
   * per the brief, this must never crash.
   */
  private fcmConfigured(): boolean {
    return Boolean(
      process.env.FCM_PROJECT_ID &&
      process.env.FCM_CLIENT_EMAIL &&
      process.env.FCM_PRIVATE_KEY,
    );
  }

  async handleOrderWebhook(payload: any) {
    // payload is expected to be a Supabase Database Webhook payload for `orders` table.
    const { type, record, old_record } = payload;

    this.logger.log(`Received webhook for order ${record?.id}, type: ${type}`);

    if (type === 'UPDATE' && record && old_record) {
      if (record.status !== old_record.status) {
        if (!this.fcmConfigured()) {
          this.logger.warn(
            'FCM is not configured (FCM_PROJECT_ID/FCM_CLIENT_EMAIL/FCM_PRIVATE_KEY) — skipping push fan-out',
          );
          return { success: true };
        }

        this.logger.log(
          `[FCM Stub] Sending push notification to customer ${record.customer_id}: Order status changed to ${record.status}`,
        );

        if (record.assigned_rider_id) {
          this.logger.log(
            `[FCM Stub] Sending push notification to rider ${record.assigned_rider_id}: Order status changed to ${record.status}`,
          );
        }
      }
    }

    return { success: true };
  }
}
