import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { validateEnv } from './common/validate-env';

// Global BigInt JSON serialization fallback for Express / JSON.stringify
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

async function bootstrap() {
  // Fail fast on missing/misconfigured env before the Nest app (and its DB
  // connection) even starts booting.
  validateEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const logger = new Logger('Bootstrap');
  const isProduction = process.env.NODE_ENV === 'production';

  // Render (and most PaaS hosts) sit the app behind a single reverse proxy
  // hop. Without this, Express ignores X-Forwarded-For and every request
  // appears to originate from the load balancer's IP — which means the
  // global ThrottlerGuard buckets ALL callers together under one IP instead
  // of rate-limiting per real client.
  app.set('trust proxy', 1);

  // Security headers (CSP, X-Frame-Options, etc.) — this is a JSON API
  // consumed by the mobile apps and Swagger UI, not a browser-rendered site,
  // so helmet's defaults are appropriate as-is.
  app.use(helmet());

  // Global validation: whitelist strips unknown props, transform applies
  // class-transformer decorators (e.g. phone normalization) before validation.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  // CORS: origins come from CORS_ORIGINS (comma-separated). validateEnv()
  // already guarantees this is set in production; here we just parse it.
  // In development, an unset CORS_ORIGINS falls back to "allow all" with a
  // loud warning rather than blocking local/emulator testing.
  const corsOrigins = process.env.CORS_ORIGINS;
  if (corsOrigins) {
    app.enableCors({ origin: corsOrigins.split(',').map((o) => o.trim()) });
  } else {
    logger.warn(
      'CORS_ORIGINS is not set — allowing all origins. Set CORS_ORIGINS before deploying to production.',
    );
    app.enableCors();
  }

  // Swagger is a dev/staging convenience by default, but the interim
  // merchant flow (spec D-2) uses Swagger UI to drive
  // PATCH /orders/:id/accept|ready until a merchant panel exists — so it can
  // be opted back on in production via SWAGGER_ENABLED=true. See
  // .env.example for the operational note.
  const swaggerEnabled =
    !isProduction || process.env.SWAGGER_ENABLED === 'true';
  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('Cartman API')
      .setDescription('Cartman Delivery & Errands API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
