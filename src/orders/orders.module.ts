import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { FeedService } from './feed.service';
import { OrdersController } from './orders.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [PrismaModule, LedgerModule],
  controllers: [OrdersController],
  providers: [OrdersService, FeedService],
})
export class OrdersModule {}
