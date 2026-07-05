import {
  Controller,
  Post,
  Body,
  Headers,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('supabase')
  async handleSupabaseWebhook(
    @Headers('x-supabase-webhook-secret') secret: string,
    @Body() payload: any,
  ) {
    const expected = process.env.SUPABASE_WEBHOOK_SECRET;

    // No hardcoded fallback: if the secret isn't configured, every request is
    // rejected (401) rather than silently accepting a guessable default
    // string. This intentionally disables the endpoint until an operator
    // sets SUPABASE_WEBHOOK_SECRET, logged once per rejected call so it's
    // obvious in the runbook/logs why webhooks are bouncing.
    if (!expected) {
      this.logger.warn(
        'Rejecting Supabase webhook: SUPABASE_WEBHOOK_SECRET is not configured',
      );
      throw new UnauthorizedException('Webhook is not configured');
    }

    if (!secret || secret !== expected) {
      throw new UnauthorizedException('Invalid webhook secret');
    }

    return this.webhooksService.handleOrderWebhook(payload);
  }
}
