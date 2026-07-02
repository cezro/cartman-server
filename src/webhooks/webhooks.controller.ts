import {
  Controller,
  Post,
  Body,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('supabase')
  async handleSupabaseWebhook(
    @Headers('x-supabase-webhook-secret') secret: string,
    @Body() payload: any,
  ) {
    // In a real app, verify against process.env.SUPABASE_WEBHOOK_SECRET
    // For now, just a basic check if it exists or matches a dummy value
    if (
      !secret ||
      secret !== (process.env.SUPABASE_WEBHOOK_SECRET || 'my-super-secret')
    ) {
      throw new UnauthorizedException('Invalid webhook secret');
    }

    return this.webhooksService.handleOrderWebhook(payload);
  }
}
