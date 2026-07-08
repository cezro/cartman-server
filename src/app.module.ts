import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { ProfilesModule } from './profiles/profiles.module';
import { MerchantsModule } from './merchants/merchants.module';
import { OrdersModule } from './orders/orders.module';
import { RidersModule } from './riders/riders.module';
import { LedgerModule } from './ledger/ledger.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { StorageModule } from './storage/storage.module';
import { AdminModule } from './admin/admin.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LoggingInterceptor } from './common/logging.interceptor';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Global defense-in-depth rate limit — generous default (100 req/min
    // per IP); the OTP endpoints layer a much stricter per-route override
    // on top via @Throttle() (see auth.controller.ts), in addition to
    // OtpService's own per-identifier DB-backed rate limit.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    PrismaModule,
    AuthModule,
    ProfilesModule,
    MerchantsModule,
    OrdersModule,
    RidersModule,
    LedgerModule,
    WebhooksModule,
    StorageModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Order matters: APP_GUARD guards run in registration order, and
    // RolesGuard reads request.user, which JwtAuthGuard (passport) sets.
    // With RolesGuard global but JwtAuthGuard controller-level only (the
    // previous wiring), the global RolesGuard ran BEFORE any controller
    // guard and rejected every @Roles route with 401 even for valid
    // tokens. Public routes opt out via @Public() (public.decorator.ts).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
