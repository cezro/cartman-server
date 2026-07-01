import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  async handleOrderWebhook(payload: any) {
    // payload is expected to be a Supabase Database Webhook payload for `orders` table.
    const { type, record, old_record } = payload;
    
    this.logger.log(`Received webhook for order ${record?.id}, type: ${type}`);

    if (type === 'UPDATE' && record && old_record) {
      if (record.status !== old_record.status) {
        this.logger.log(`[FCM Stub] Sending push notification to customer ${record.customer_id}: Order status changed to ${record.status}`);
        
        if (record.assigned_rider_id) {
            this.logger.log(`[FCM Stub] Sending push notification to rider ${record.assigned_rider_id}: Order status changed to ${record.status}`);
        }
      }
    }
    
    return { success: true };
  }
}
