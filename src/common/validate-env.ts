import Joi from 'joi';

/**
 * Fail-fast env validation, run once at the top of bootstrap() in main.ts.
 * The app doesn't use ConfigModule's own `validationSchema` option (Nest's
 * usual idiom) — app.module.ts's ConfigModule.forRoot() has no schema wired
 * up — so a small standalone validator called before NestFactory.create()
 * is the simpler fit here; it also lets us assert on the pure function in
 * a unit test without spinning up the whole module tree.
 *
 * Required in every environment: DATABASE_URL, SUPABASE_JWT_SECRET — the
 * app cannot serve a single request without a DB connection or a way to
 * validate Supabase-issued JWTs (JwtStrategy).
 *
 * Required additionally when NODE_ENV=production:
 *  - SUPABASE_WEBHOOK_SECRET — otherwise WebhooksController silently 401s
 *    every Supabase webhook forever (see webhooks.controller.ts).
 *  - CORS_ORIGINS — main.ts refuses to fall back to "allow all" in prod.
 *  - SEMAPHORE_API_KEY — optional for now (SMS OTP is a future integration).
 *  - RESEND_API_KEY — optional for now (email OTP is a future integration).
 */
export function validateEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  const isProduction = env.NODE_ENV === 'production';
  const otpDevMode = env.OTP_DEV_MODE === 'true';

  // Optional vars must explicitly .allow('') — dotenv/.env files commonly
  // have a var present but blank (e.g. `SEMAPHORE_API_KEY=` in dev, filled in
  // only for prod), and Joi.string() rejects empty string by default even
  // when .optional(). Without .allow(''), a blank-but-present dev var would
  // false-positive as "missing" and refuse to boot — exactly the failure
  // mode this validator must not have.
  const schema = Joi.object({
    DATABASE_URL: Joi.string().required(),
    SUPABASE_JWT_SECRET: Joi.string().required(),
    SUPABASE_WEBHOOK_SECRET: isProduction
      ? Joi.string().required()
      : Joi.string().optional().allow(''),
    CORS_ORIGINS: isProduction
      ? Joi.string().required()
      : Joi.string().optional().allow(''),
    SEMAPHORE_API_KEY: Joi.string().optional().allow(''),
    RESEND_API_KEY: Joi.string().optional().allow(''),
  }).unknown(true);

  const { error } = schema.validate(env, { abortEarly: false });

  if (error) {
    const missing = error.details.map((d) => `  - ${d.message}`).join('\n');
    throw new Error(
      `Missing required environment variable(s):\n${missing}\n\n` +
        'Check .env.example and set these before starting the server.',
    );
  }
}
