import { validateEnv } from './validate-env';

describe('validateEnv', () => {
  const BASE_DEV_ENV = {
    DATABASE_URL: 'postgres://user:pass@host:5432/db',
    SUPABASE_JWT_SECRET: 'super-secret',
    NODE_ENV: 'development',
  };

  it('passes with only the always-required vars set in development', () => {
    expect(() => validateEnv(BASE_DEV_ENV)).not.toThrow();
  });

  // Regression: a real .env commonly has optional vars present but blank
  // (e.g. `SEMAPHORE_API_KEY=` with no value) rather than absent entirely.
  // Joi.string().optional() rejects '' by default unless .allow('') is
  // added — this reproduces the exact dev-boot false positive that
  // surfaced when smoke-testing `npm run start:dev` against .env.
  it('does not false-positive on optional vars that are present but blank, in development', () => {
    const env = {
      ...BASE_DEV_ENV,
      SUPABASE_WEBHOOK_SECRET: '',
      SEMAPHORE_API_KEY: '',
      CORS_ORIGINS: '',
      OTP_DEV_MODE: 'true',
    };
    expect(() => validateEnv(env)).not.toThrow();
  });

  it('throws naming DATABASE_URL when missing', () => {
    const env = { ...BASE_DEV_ENV };
    delete (env as Record<string, unknown>).DATABASE_URL;
    expect(() => validateEnv(env)).toThrow(/DATABASE_URL/);
  });

  it('throws naming SUPABASE_JWT_SECRET when missing', () => {
    const env = { ...BASE_DEV_ENV };
    delete (env as Record<string, unknown>).SUPABASE_JWT_SECRET;
    expect(() => validateEnv(env)).toThrow(/SUPABASE_JWT_SECRET/);
  });

  it('lists every missing var in one error when several are absent', () => {
    expect(() => validateEnv({ NODE_ENV: 'development' })).toThrow(
      /DATABASE_URL[\s\S]*SUPABASE_JWT_SECRET|SUPABASE_JWT_SECRET[\s\S]*DATABASE_URL/,
    );
  });

  describe('production requirements', () => {
    const PROD_ENV = {
      ...BASE_DEV_ENV,
      NODE_ENV: 'production',
      SUPABASE_WEBHOOK_SECRET: 'whsec',
      CORS_ORIGINS: 'https://app.cartman.ph',
      SEMAPHORE_API_KEY: 'sk_live',
    };

    it('passes when all production-required vars are present', () => {
      expect(() => validateEnv(PROD_ENV)).not.toThrow();
    });

    it('throws naming SUPABASE_WEBHOOK_SECRET when missing in production', () => {
      const env = { ...PROD_ENV };
      delete (env as Record<string, unknown>).SUPABASE_WEBHOOK_SECRET;
      expect(() => validateEnv(env)).toThrow(/SUPABASE_WEBHOOK_SECRET/);
    });

    it('throws naming CORS_ORIGINS when missing in production', () => {
      const env = { ...PROD_ENV };
      delete (env as Record<string, unknown>).CORS_ORIGINS;
      expect(() => validateEnv(env)).toThrow(/CORS_ORIGINS/);
    });

    it('throws naming SEMAPHORE_API_KEY when missing in production and OTP_DEV_MODE is not true', () => {
      const env = { ...PROD_ENV };
      delete (env as Record<string, unknown>).SEMAPHORE_API_KEY;
      expect(() => validateEnv(env)).toThrow(/SEMAPHORE_API_KEY/);
    });

    it('does not require SEMAPHORE_API_KEY in production when OTP_DEV_MODE is true', () => {
      const env = { ...PROD_ENV, OTP_DEV_MODE: 'true' };
      delete (env as Record<string, unknown>).SEMAPHORE_API_KEY;
      expect(() => validateEnv(env)).not.toThrow();
    });

    it('does not require production-only vars outside production', () => {
      expect(() => validateEnv(BASE_DEV_ENV)).not.toThrow();
    });
  });
});
