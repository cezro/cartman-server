import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import jwt from 'jsonwebtoken';
import { AppModule } from './../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SupabaseAdminService } from '../src/common/supabase-admin.service';

/**
 * Admin Dashboard V2 e2e gate. Same harness as admin.e2e-spec.ts: real
 * AppModule + real HTTP pipeline (guards, global ValidationPipe, exception
 * filter) with PrismaService replaced by a jest mock. The auth-override
 * routes additionally override SupabaseAdminService so no real Supabase
 * service-role call is made.
 */
describe('AdminModule V2 (e2e)', () => {
  let app: INestApplication<App>;
  let prismaMock: {
    profiles: { findUnique: jest.Mock };
    incidents: { findMany: jest.Mock; count: jest.Mock };
    global_config: { findUnique: jest.Mock; create: jest.Mock };
  };
  let supabaseMock: {
    updateUserById: jest.Mock;
    getUserById: jest.Mock;
    generateLink: jest.Mock;
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
      incidents: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      global_config: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          base_rate: 39,
          base_radius: 2,
          surcharge_per_km: 15,
          strike_limit: 3,
          auto_assign: true,
          pro_exposure_multiplier: 2,
          allow_ads: true,
          updated_at: new Date('2026-07-09T00:00:00Z'),
        }),
        create: jest.fn(),
      },
    };
    supabaseMock = {
      updateUserById: jest.fn(),
      getUserById: jest.fn(),
      generateLink: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(SupabaseAdminService)
      .useValue(supabaseMock)
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

  it('GET /admin/config without a token returns 401', async () => {
    const res = await request(app.getHttpServer()).get('/admin/config');
    expect(res.status).toBe(401);
  });

  it('GET /admin/incidents with a customer-role token returns 403', async () => {
    prismaMock.profiles.findUnique.mockResolvedValue({
      id: 'user-1',
      role: 'customer',
    });

    const res = await request(app.getHttpServer())
      .get('/admin/incidents')
      .set('Authorization', `Bearer ${signBearerFor('user-1')}`);

    expect(res.status).toBe(403);
  });

  it('GET /admin/config with an admin token returns 200 with Number fields', async () => {
    prismaMock.profiles.findUnique.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
    });

    const res = await request(app.getHttpServer())
      .get('/admin/config')
      .set('Authorization', `Bearer ${signBearerFor('admin-1')}`);

    expect(res.status).toBe(200);
    const body = res.body as { id: number; base_rate: number };
    expect(body.id).toBe(1);
    expect(body.base_rate).toBe(39);
    expect(typeof body.base_rate).toBe('number');
  });

  it('GET /admin/incidents with an admin token returns the envelope', async () => {
    prismaMock.profiles.findUnique.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
    });

    const res = await request(app.getHttpServer())
      .get('/admin/incidents')
      .set('Authorization', `Bearer ${signBearerFor('admin-1')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
  });

  it('POST /admin/incidents missing a required field returns 400', async () => {
    prismaMock.profiles.findUnique.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
    });

    const res = await request(app.getHttpServer())
      .post('/admin/incidents')
      .set('Authorization', `Bearer ${signBearerFor('admin-1')}`)
      .send({ type: 'payment' }); // severity missing

    expect(res.status).toBe(400);
  });

  it('POST /admin/users/:id/reset-2fa returns the recovery action_link', async () => {
    prismaMock.profiles.findUnique.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
    });
    supabaseMock.getUserById.mockResolvedValue({
      data: { user: { id: 'target', email: 'target@cartman.ph' } },
      error: null,
    });
    supabaseMock.generateLink.mockResolvedValue({
      data: { properties: { action_link: 'https://recover.link/abc123' } },
      error: null,
    });

    const res = await request(app.getHttpServer())
      .post('/admin/users/target/reset-2fa')
      .set('Authorization', `Bearer ${signBearerFor('admin-1')}`);

    expect(res.status).toBe(201);
    const body = res.body as { action_link: string };
    expect(body.action_link).toBe('https://recover.link/abc123');
  });
});
