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
 *
 * OTP delivery keys are required when their provider is actually selected:
 * SEMAPHORE_API_KEY when OTP_SMS_PROVIDER=semaphore, RESEND_API_KEY when
 * OTP_EMAIL_PROVIDER=resend — and never when OTP_DEV_MODE=true, which forces
 * the stub. Selection itself defaults off the credential (see
 * `defaultSmsProvider`), so an environment holding a Semaphore key keeps
 * sending real SMS without also having to name the provider.
 *
 * This validator checks that a *selected* provider is configured;
 * `assertSafeOtpConfig` separately refuses to boot a production environment
 * that resolved to the stub, since the stub returns codes in the API response.
 *
 * Deliberately optional everywhere, including production:
 *  - MAPBOX_TOKEN — the geocoding proxy (GeoModule) fails soft to empty
 *    results when it is unset, and the address form falls back to manual
 *    pin-drop. Requiring it would let a missing map key block every order in
 *    the system, which is a far worse failure than losing address search.
 */
export function validateEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  const isProduction = env.NODE_ENV === 'production';
  const otpDevMode = env.OTP_DEV_MODE === 'true';
  // Mirrors `defaultSmsProvider`: an unset selection means Semaphore when its
  // key is present. Hardcoding 'stub' here would let a half-configured
  // environment (key blank, provider named) slip past the required-key check.
  const smsProvider = (
    env.OTP_SMS_PROVIDER ?? (env.SEMAPHORE_API_KEY ? 'semaphore' : 'stub')
  ).toLowerCase();
  const emailProvider = (env.OTP_EMAIL_PROVIDER ?? 'stub').toLowerCase();
  const semaphoreRequired = !otpDevMode && smsProvider === 'semaphore';
  const resendRequired = !otpDevMode && emailProvider === 'resend';

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
    // Only the supported provider names — a typo like OTP_SMS_PROVIDER=brevo
    // before Brevo is implemented fails fast at boot instead of silently
    // stubbing. Add new names here when their provider lands.
    OTP_SMS_PROVIDER: Joi.string()
      .valid('stub', 'semaphore')
      .optional()
      .allow(''),
    OTP_EMAIL_PROVIDER: Joi.string()
      .valid('stub', 'resend')
      .optional()
      .allow(''),
    SEMAPHORE_API_KEY: semaphoreRequired
      ? Joi.string().required()
      : Joi.string().optional().allow(''),
    RESEND_API_KEY: resendRequired
      ? Joi.string().required()
      : Joi.string().optional().allow(''),
    MAPBOX_TOKEN: Joi.string().optional().allow(''),
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
