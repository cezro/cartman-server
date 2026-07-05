import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { validateEnv } from './common/validate-env';

async function bootstrap() {
  // Fail fast on missing/misconfigured env before the Nest app (and its DB
  // connection) even starts booting.
  validateEnv();

  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');
  const isProduction = process.env.NODE_ENV === 'production';

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

  // Swagger is a dev/staging convenience — never expose the API surface at
  // /api/docs in production.
  if (!isProduction) {
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
