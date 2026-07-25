import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { FcmService } from './fcm.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, FcmService],
})
export class WebhooksModule {}
