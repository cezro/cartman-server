import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { UserOrIpThrottlerGuard } from './common/user-or-ip-throttler.guard';
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
import { GeoModule } from './geo/geo.module';
import { AdminModule } from './admin/admin.module';
import { AccountsModule } from './accounts/accounts.module';
import { PushModule } from './push/push.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LoggingInterceptor } from './common/logging.interceptor';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Drives the hourly account-deletion sweep (L5) and the 10-second push
    // outbox drain (L3) — the two jobs that have to run without a client
    // asking.
    ScheduleModule.forRoot(),
    // Global defense-in-depth rate limit: 200 req/min per user (or per IP on
    // @Public routes) — see UserOrIpThrottlerGuard for why the key is the
    // user id, not the IP. 200/min sits comfortably above the busiest real
    // client (an on-duty rider whose feed refetches on every realtime change,
    // debounced 500ms ≈ up to ~120/min in a hot dispatch window) while still
    // capping a runaway or compromised client. The OTP endpoints layer a much
    // stricter per-route override on top via @Throttle() (see
    // auth.controller.ts), plus OtpService's own per-phone DB-backed limit;
    // the Supabase webhook opts out entirely via @SkipThrottle().
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 200 }]),
    PrismaModule,
    AuthModule,
    ProfilesModule,
    MerchantsModule,
    OrdersModule,
    RidersModule,
    LedgerModule,
    WebhooksModule,
    StorageModule,
    GeoModule,
    AdminModule,
    AccountsModule,
    PushModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Order matters: APP_GUARD guards run in registration order.
    // 1. JwtAuthGuard (passport) first — it populates request.user, which
    //    both of the next two guards read. Public routes opt out via
    //    @Public() (public.decorator.ts). (Before the guard-topology fix,
    //    RolesGuard ran before any auth guard and rejected every @Roles
    //    route with 401 even for valid tokens.)
    // 2. UserOrIpThrottlerGuard next — it keys the rate-limit bucket on
    //    request.user.id (set in step 1), falling back to IP on @Public
    //    routes. It must run AFTER JwtAuthGuard for that key to exist.
    // 3. RolesGuard last — reads request.user.role.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserOrIpThrottlerGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
