import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import jwt from 'jsonwebtoken';
import { AppModule } from './../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Regression gate for the global guard ordering fix (JwtAuthGuard must run
 * as an APP_GUARD BEFORE RolesGuard — see app.module.ts). Before the fix,
 * the global RolesGuard ran before the controller-level JwtAuthGuard, saw
 * no request.user, and rejected EVERY @Roles route with 401 even for valid
 * tokens — feed/claim/duty/ledger were unreachable by real clients.
 */
describe('Global guard ordering (e2e)', () => {
  let app: INestApplication<App>;
  let prismaMock: {
    profiles: { findUnique: jest.Mock };
    riders: { findUnique: jest.Mock };
    orders: { findMany: jest.Mock };
    rider_wallet_transactions: { findMany: jest.Mock };
    rider_locations: { findFirst: jest.Mock };
  };

  function signBearerFor(userId: string): string {
    return jwt.sign(
      { sub: userId, aud: 'authenticated', role: 'authenticated' },
      process.env.SUPABASE_JWT_SECRET!,
    );
  }

  beforeEach(async () => {
    prismaMock = {
      profiles: { findUnique: jest.fn() },
      riders: { findUnique: jest.fn() },
      orders: { findMany: jest.fn() },
      rider_wallet_transactions: { findMany: jest.fn() },
      rider_locations: { findFirst: jest.fn() },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('a valid rider-role token reaches GET /orders/feed (was 401 before the fix)', async () => {
    prismaMock.profiles.findUnique.mockResolvedValue({
      id: 'rider-1',
      role: 'rider',
    });
    prismaMock.riders.findUnique.mockResolvedValue({
      id: 'rider-1',
      is_active: true,
      // This test is about guard *ordering* — that a rider-role token is not
      // 401'd. The approval gate is incidental to it, so the fixture is an
      // approved rider; the gate itself is covered below.
      is_verified: true,
    });
    prismaMock.rider_wallet_transactions.findMany.mockResolvedValue([]);
    prismaMock.orders.findMany.mockResolvedValue([]);
    prismaMock.rider_locations.findFirst.mockResolvedValue(null);

    const res = await request(app.getHttpServer())
      .get('/orders/feed')
      .set('Authorization', `Bearer ${signBearerFor('rider-1')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('an unapproved rider gets 403 on GET /orders/feed, through the whole stack', async () => {
    // The unit test covers the handler; this covers the route as deployed —
    // guards, pipes and filter included — because the gate this replaces was
    // one that existed in the database and never reached the HTTP path.
    prismaMock.profiles.findUnique.mockResolvedValue({
      id: 'rider-1',
      role: 'rider',
    });
    prismaMock.riders.findUnique.mockResolvedValue({
      id: 'rider-1',
      is_active: true,
      is_verified: false,
    });

    const res = await request(app.getHttpServer())
      .get('/orders/feed')
      .set('Authorization', `Bearer ${signBearerFor('rider-1')}`);

    expect(res.status).toBe(403);
    expect((res.body as { message: string }).message).toMatch(
      /still being reviewed/,
    );
    // Never reached the feed query.
    expect(prismaMock.orders.findMany).not.toHaveBeenCalled();
  });

  it('a valid customer-role token on GET /orders/feed gets 403 (role mismatch), not 401', async () => {
    prismaMock.profiles.findUnique.mockResolvedValue({
      id: 'user-1',
      role: 'customer',
    });

    const res = await request(app.getHttpServer())
      .get('/orders/feed')
      .set('Authorization', `Bearer ${signBearerFor('user-1')}`);

    expect(res.status).toBe(403);
  });

  it('GET /health stays reachable without a token (@Public)', async () => {
    const res = await request(app.getHttpServer()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('POST /webhooks/supabase without a token reaches the controller (@Public) and is rejected by ITS OWN secret check', async () => {
    const res = await request(app.getHttpServer())
      .post('/webhooks/supabase')
      .send({ type: 'INSERT', record: { id: 'order-1' } });

    // 401 comes from WebhooksController's shared-secret check (the message
    // proves the request got past the global JWT guard into the handler),
    // not from JwtAuthGuard's bare "Unauthorized". Which message depends on
    // whether SUPABASE_WEBHOOK_SECRET is set in the local .env.
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toMatch(
      /Webhook is not configured|Invalid webhook secret/,
    );
  });

  it('POST /auth/send-email-otp stays reachable without a token (@Public)', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/send-email-otp')
      .send({});

    // 400 (validation: email required) — NOT 401; the route is public and
    // the request reached the validation pipe.
    expect(res.status).toBe(400);
  });
});
