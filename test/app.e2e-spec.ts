import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import jwt from 'jsonwebtoken';
import { AppModule } from './../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * e2e gate (6.5). Runs the real Nest app + real HTTP pipeline (guards,
 * global ValidationPipe, exception filter) but with PrismaService replaced
 * by a jest-mock — no real DB connection is ever opened. Covers the smoke
 * scenarios from the brief; a full place->claim->deliver flow against a
 * real DB is out of scope here (see docs/dev-runbook.md for the manual
 * seed-based flow).
 */
describe('AppModule (e2e)', () => {
  let app: INestApplication<App>;
  let prismaMock: {
    profiles: { findUnique: jest.Mock };
  };

  beforeEach(async () => {
    prismaMock = {
      profiles: { findUnique: jest.fn() },
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

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  describe('health endpoint', () => {
    it('GET /health returns 200 {status: "ok"}', () => {
      return request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect({ status: 'ok' });
    });
  });

  describe('401 JSON shape on guarded endpoints without a bearer token', () => {
    it('GET /auth/me', async () => {
      const res = await request(app.getHttpServer()).get('/auth/me');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ statusCode: 401 });
    });

    it('POST /orders/food', async () => {
      const res = await request(app.getHttpServer())
        .post('/orders/food')
        .send({});
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ statusCode: 401 });
    });

    it('GET /orders/feed', async () => {
      const res = await request(app.getHttpServer()).get('/orders/feed');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ statusCode: 401 });
    });
  });

  describe('POST /auth/send-otp with a malformed phone', () => {
    function signBearerFor(userId: string): string {
      // JwtAuthGuard validates against SUPABASE_JWT_SECRET via JwtStrategy,
      // which then looks up the profile's role from PrismaService (mocked
      // above) — sign a token the same way Supabase would (sub = user id).
      return jwt.sign(
        { sub: userId, aud: 'authenticated', role: 'authenticated' },
        process.env.SUPABASE_JWT_SECRET!,
      );
    }

    it('returns 400 with the exact PH phone normalization message', async () => {
      prismaMock.profiles.findUnique.mockResolvedValue({
        id: 'user-1',
        role: 'customer',
      });

      const res = await request(app.getHttpServer())
        .post('/auth/send-otp')
        .set('Authorization', `Bearer ${signBearerFor('user-1')}`)
        .send({ phone: '12345' });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain(
        'Phone must be a Philippine mobile number (+639XXXXXXXXX)',
      );
    });
  });

  describe('POST /webhooks/supabase without the secret header', () => {
    it('returns 401', async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks/supabase')
        .send({ type: 'INSERT', record: { id: 'order-1' } });

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ statusCode: 401 });
    });
  });
});
