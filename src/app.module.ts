import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ProfilesModule } from './profiles/profiles.module';
import { MerchantsModule } from './merchants/merchants.module';
import { OrdersModule } from './orders/orders.module';
import { RidersModule } from './riders/riders.module';
import { LedgerModule } from './ledger/ledger.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    ProfilesModule,
    MerchantsModule,
    OrdersModule,
    RidersModule,
    LedgerModule,
    WebhooksModule,
    StorageModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
