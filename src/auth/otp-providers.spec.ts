import {
  resolveSmsProvider,
  resolveEmailProvider,
  describeOtpProviders,
  assertSafeOtpConfig,
  smsOtpMessage,
  emailOtpHtml,
  fitsSingleSmsSegment,
} from './otp-providers';

describe('OTP provider resolution', () => {
  describe('resolveSmsProvider', () => {
    it('defaults to the held stub when nothing is configured', () => {
      const p = resolveSmsProvider({});
      expect(p.name).toBe('stub');
      expect(p.isStub).toBe(true);
    });

    it('defaults to Semaphore when its key is present but no provider is named', () => {
      // Render sets SEMAPHORE_API_KEY and no OTP_SMS_PROVIDER. A flat 'stub'
      // default would have silently switched live SMS off there — and worse,
      // switched ON returning the code in the response of a public endpoint.
      const p = resolveSmsProvider({ SEMAPHORE_API_KEY: 'sk_live' });
      expect(p.name).toBe('semaphore');
      expect(p.isStub).toBe(false);
    });

    it('honours an explicit stub selection even when a key is present', () => {
      // Holding a provider stays possible; it just has to be said out loud.
      const p = resolveSmsProvider({
        OTP_SMS_PROVIDER: 'stub',
        SEMAPHORE_API_KEY: 'sk_live',
      });
      expect(p.isStub).toBe(true);
    });

    it('returns the stub when OTP_DEV_MODE=true even if semaphore is selected', () => {
      const p = resolveSmsProvider({
        OTP_DEV_MODE: 'true',
        OTP_SMS_PROVIDER: 'semaphore',
        SEMAPHORE_API_KEY: 'sk_live',
      });
      expect(p.isStub).toBe(true);
    });

    it('returns the Semaphore provider when selected with a key', () => {
      const p = resolveSmsProvider({
        OTP_SMS_PROVIDER: 'semaphore',
        SEMAPHORE_API_KEY: 'sk_live',
      });
      expect(p.name).toBe('semaphore');
      expect(p.isStub).toBe(false);
    });

    it('falls back to the stub when semaphore is selected but the key is missing', () => {
      const p = resolveSmsProvider({ OTP_SMS_PROVIDER: 'semaphore' });
      expect(p.isStub).toBe(true);
    });

    it('falls back to the stub on an unknown provider name', () => {
      const p = resolveSmsProvider({ OTP_SMS_PROVIDER: 'brevo' });
      expect(p.isStub).toBe(true);
    });
  });

  describe('resolveEmailProvider', () => {
    it('defaults to the held stub', () => {
      expect(resolveEmailProvider({}).isStub).toBe(true);
    });

    it('returns the Resend provider when selected with a key', () => {
      const p = resolveEmailProvider({
        OTP_EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_live',
      });
      expect(p.name).toBe('resend');
      expect(p.isStub).toBe(false);
    });

    it('falls back to the stub when resend is selected but the key is missing', () => {
      expect(
        resolveEmailProvider({ OTP_EMAIL_PROVIDER: 'resend' }).isStub,
      ).toBe(true);
    });
  });

  describe('describeOtpProviders', () => {
    it('marks held stubs and names live providers', () => {
      expect(describeOtpProviders({})).toContain('SMS: stub (HELD');
      expect(
        describeOtpProviders({
          OTP_SMS_PROVIDER: 'semaphore',
          SEMAPHORE_API_KEY: 'sk_live',
          OTP_EMAIL_PROVIDER: 'resend',
          RESEND_API_KEY: 're_live',
        }),
      ).toBe('OTP delivery — SMS: semaphore; email: resend');
    });
  });

  describe('assertSafeOtpConfig', () => {
    it('refuses to boot production when SMS resolved to the held stub', () => {
      // The failure this prevents: /auth/send-otp is public, and a stub makes
      // OtpService return the code in the response — so anyone could request
      // a code for any number, read it back, and clear the COD phone gate.
      expect(() => assertSafeOtpConfig({ NODE_ENV: 'production' })).toThrow(
        /Unsafe OTP configuration/,
      );
    });

    it('refuses to boot production with OTP_DEV_MODE left on', () => {
      expect(() =>
        assertSafeOtpConfig({
          NODE_ENV: 'production',
          OTP_DEV_MODE: 'true',
          SEMAPHORE_API_KEY: 'sk_live',
        }),
      ).toThrow(/Unsafe OTP configuration/);
    });

    it('allows production with a real SMS provider', () => {
      expect(() =>
        assertSafeOtpConfig({
          NODE_ENV: 'production',
          SEMAPHORE_API_KEY: 'sk_live',
        }),
      ).not.toThrow();
    });

    it('leaves non-production environments alone', () => {
      // Dev and test are exactly where the stub is wanted.
      expect(() => assertSafeOtpConfig({})).not.toThrow();
      expect(() =>
        assertSafeOtpConfig({ NODE_ENV: 'development' }),
      ).not.toThrow();
    });
  });

  describe('message templates', () => {
    it('names the product, the code, and the expiry', () => {
      const body = smsOtpMessage('123456');
      expect(body).toContain('Cartman');
      expect(body).toContain('123456');
      expect(body).toContain('10 minutes');
    });

    it('keeps the code as six bare digits for SMS autofill', () => {
      // Android's SMS Retriever and iOS autofill key off a plain run of
      // digits near a keyword. Spacing or bracketing the code silently kills
      // the one-tap fill that CartOtpField advertises.
      expect(smsOtpMessage('123456')).toMatch(/(^|\s)123456\b/);
    });

    it('fits a single billed SMS segment', () => {
      // Semaphore bills per 160-char segment. Copy that creeps over the line
      // doubles the cost of every OTP with nothing visible at runtime.
      expect(fitsSingleSmsSegment(smsOtpMessage('123456'))).toBe(true);
    });

    it('the segment check accounts for the gateway-prepended sender name', () => {
      // A message that is exactly 160 chars still overflows once Semaphore
      // prefixes "CARTMAN: ".
      expect(fitsSingleSmsSegment('x'.repeat(160))).toBe(false);
    });

    it('the email body carries the code and does not alarm a non-requester', () => {
      const html = emailOtpHtml('654321');
      expect(html).toContain('654321');
      expect(html).toContain('ignore this email');
    });
  });
});
