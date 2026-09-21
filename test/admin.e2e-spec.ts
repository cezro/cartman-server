import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import jwt from 'jsonwebtoken';
import { AppModule } from './../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Admin surface e2e gate. Same harness as app.e2e-spec.ts: real AppModule +
 * real HTTP pipeline (guards, global ValidationPipe, exception filter) with
 * PrismaService replaced by a jest mock — no real DB connection.
 */
describe('AdminModule (e2e)', () => {
  let app: INestApplication<App>;
  let prismaMock: {
    profiles: { findUnique: jest.Mock };
    orders: { count: jest.Mock; findMany: jest.Mock };
    riders: { count: jest.Mock };
    rider_wallet_transactions: { groupBy: jest.Mock };
  };

  function signBearerFor(userId: string): string {
    // JwtAuthGuard validates against SUPABASE_JWT_SECRET via JwtStrategy,
    // which then looks up the profile's role from PrismaService (mocked
    // above) — sign a token the same way Supabase would (sub = user id).
    return jwt.sign(
      { sub: userId, aud: 'authenticated', role: 'authenticated' },
      process.env.SUPABASE_JWT_SECRET!,
    );
  }

  beforeEach(async () => {
    prismaMock = {
      profiles: { findUnique: jest.fn() },
      orders: { count: jest.fn(), findMany: jest.fn() },
      riders: { count: jest.fn() },
      rider_wallet_transactions: { groupBy: jest.fn() },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();

    app = moduleFixture.createNestApplication();
    // Mirror main.ts's global pipe exactly — e2e specs run their own
    // bootstrap (createNestApplication), not main.ts's bootstrap().
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /admin/stats without a token returns 401 JSON', async () => {
    const res = await request(app.getHttpServer()).get('/admin/stats');

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ statusCode: 401 });
  });

  it('GET /admin/stats with a customer-role token returns 403', async () => {
    prismaMock.profiles.findUnique.mockResolvedValue({
      id: 'user-1',
      role: 'customer',
    });

    const res = await request(app.getHttpServer())
      .get('/admin/stats')
      .set('Authorization', `Bearer ${signBearerFor('user-1')}`);

    expect(res.status).toBe(403);
  });

  it('GET /admin/stats with an admin token returns 200 with the stats shape', async () => {
    prismaMock.profiles.findUnique.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
    });
    prismaMock.orders.count.mockResolvedValue(0);
    prismaMock.orders.findMany.mockResolvedValue([]);
    prismaMock.riders.count.mockResolvedValue(0);
    prismaMock.rider_wallet_transactions.groupBy.mockResolvedValue([]);

    const res = await request(app.getHttpServer())
      .get('/admin/stats')
      .set('Authorization', `Bearer ${signBearerFor('admin-1')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orders: {
        active: 0,
        unassigned: 0,
        delivered_today: 0,
        canceled_today: 0,
        // Added to the service on 2026-08-09 and never mirrored here, which is
        // why this suite had been red ever since. A failed delivery is not
        // active, delivered or canceled, so without this count it is invisible.
        delivery_failed_today: 0,
      },
      fleet: { on_duty: 0, total: 0 },
      cod_today: { expected: 0, remitted: 0 },
      remittance: { riders_owing: 0, outstanding_total: 0 },
      avg_delivery_secs_today: null,
    });
  });

  it('GET /admin/orders?limit=999 returns 400 (limit max 100)', async () => {
    prismaMock.profiles.findUnique.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
    });

    const res = await request(app.getHttpServer())
      .get('/admin/orders?limit=999')
      .set('Authorization', `Bearer ${signBearerFor('admin-1')}`);

    expect(res.status).toBe(400);
  });

  it('PATCH /admin/orders/x/reassign with a non-UUID rider_id returns 400', async () => {
    prismaMock.profiles.findUnique.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
    });

    const res = await request(app.getHttpServer())
      .patch('/admin/orders/x/reassign')
      .set('Authorization', `Bearer ${signBearerFor('admin-1')}`)
      .send({ rider_id: 'not-a-uuid' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('rider_id must be a UUID');
  });
});
