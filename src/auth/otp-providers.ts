import { HttpException, HttpStatus, Logger } from '@nestjs/common';

/**
 * OTP delivery seam.
 *
 * Each OtpProvider sends a 6-digit code over ONE channel (SMS or email). The
 * Semaphore (SMS) and Resend (email) implementations are kept but are HELD by
 * default — the stub is the default provider while the platform migrates to a
 * single transactional provider (Brevo, which does both SMS + email:
 * https://developers.brevo.com/docs/getting-started).
 *
 * To bring a real provider back / add Brevo later:
 *   1. add a `BrevoSmsProvider` / `BrevoEmailProvider` (implements OtpProvider),
 *   2. add a `case 'brevo':` to the resolver(s) below,
 *   3. set `OTP_SMS_PROVIDER=brevo` / `OTP_EMAIL_PROVIDER=brevo` + the key.
 * Nothing in OtpService or the controllers changes.
 *
 * A stub provider does NOT actually send — OtpService returns the code in the
 * API response instead (dev/QA only, never a real send). See resolveSmsProvider.
 */
export interface OtpProvider {
  readonly name: string;
  /** true = nothing is actually sent; OtpService returns the code inline. */
  readonly isStub: boolean;
  send(recipient: string, code: string): Promise<void>;
}

export type ProviderEnv = Record<string, string | undefined>;

const logger = new Logger('OtpProvider');

/** How long a code stays valid, in minutes. Mirrors `OtpService.OTP_EXPIRY_MIN`. */
export const OTP_EXPIRY_MINUTES = 10;

/**
 * The SMS body, in one place.
 *
 * Worth isolating from the transport for reasons that are not stylistic:
 *
 *  - **Semaphore bills per 160-character segment.** A message that creeps over
 *    the limit silently doubles the cost of every OTP, and with the copy
 *    inlined in a `fetch` call nobody notices until the credit balance does.
 *    [assertSingleSmsSegment] pins that.
 *  - **The sender name is prepended by the gateway.** Semaphore renders
 *    `CARTMAN: <message>`, so the body must not greet or re-introduce itself.
 *  - Android's SMS Retriever and iOS's autofill both key off a plain
 *    `<6 digits>` appearing near a recognisable keyword. Reformatting the code
 *    (spacing it out, wrapping it in punctuation) breaks the client-side
 *    autofill that CartOtpField advertises.
 */
export function smsOtpMessage(code: string): string {
  return `Your Cartman verification code is: ${code}. Valid for ${OTP_EXPIRY_MINUTES} minutes. Do not share this code.`;
}

/** Subject line for the email channel. */
export function emailOtpSubject(): string {
  return 'Your Cartman verification code';
}

/** Body for the email channel. */
export function emailOtpHtml(code: string): string {
  return (
    `<p>Your Cartman verification code is: <strong>${code}</strong></p>` +
    `<p>It is valid for ${OTP_EXPIRY_MINUTES} minutes. ` +
    `If you did not request it, you can ignore this email — ` +
    `nobody can use the code without it.</p>`
  );
}

/** GSM-7 single-segment limit; the ceiling one SMS is billed at. */
export const SMS_SEGMENT_LIMIT = 160;

/**
 * Whether [message] still fits in one billed SMS segment.
 *
 * Exposed so a test can hold the copy to it — the cost of getting this wrong
 * is invisible at runtime and shows up only on the invoice.
 */
export function fitsSingleSmsSegment(message: string): boolean {
  // Semaphore prefixes the approved sender name and a separator, and that
  // prefix counts toward the segment. Budgeting for the longest sender name
  // an account can register keeps the check honest.
  const senderOverhead = 11 + 2; // "SENDERNAME" + ": "
  return message.length + senderOverhead <= SMS_SEGMENT_LIMIT;
}

/** Held/dev provider: logs that it *would* send, sends nothing. */
class StubOtpProvider implements OtpProvider {
  readonly name = 'stub';
  readonly isStub = true;

  constructor(private readonly channel: 'sms' | 'email') {}

  // Deliberately ignores the code — a stub sends nothing; OtpService returns
  // the code in the response instead. (A narrower signature than the
  // interface's is still assignable to it.)
  send(recipient: string): Promise<void> {
    logger.warn(
      `OTP ${this.channel} provider is HELD (stub): not sending to ${recipient}. ` +
        'The code is returned in the API response instead — dev/QA only, never for real users.',
    );
    return Promise.resolve();
  }
}

/** Semaphore SMS gateway (PH-local). Kept, held by default. */
class SemaphoreSmsProvider implements OtpProvider {
  readonly name = 'semaphore';
  readonly isStub = false;

  constructor(
    private readonly apiKey: string,
    private readonly senderName: string,
  ) {}

  async send(phone: string, code: string): Promise<void> {
    const message = smsOtpMessage(code);
    const response = await fetch('https://api.semaphore.co/api/v4/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: this.apiKey,
        number: phone.replace('+', ''),
        message,
        sendername: this.senderName,
      }),
    });

    // Semaphore reports some validation failures (e.g. an unregistered sender
    // name) as HTTP 200 with an error object — observed live 2026-07-18 — so
    // `response.ok` alone reports success while no SMS ever left. A real
    // accept is always an ARRAY of message objects carrying `message_id`.
    //
    // Carried over from the inline implementation this class replaced. The
    // extraction had reverted it to a bare `response.ok`, which is the exact
    // bug that took a live send to find.
    const bodyText = await response.text();
    let accepted = false;
    if (response.ok) {
      try {
        const parsed: unknown = JSON.parse(bodyText);
        accepted =
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          parsed.every(
            (m: unknown) =>
              typeof m === 'object' && m !== null && 'message_id' in m,
          );
      } catch {
        accepted = false;
      }
    }

    if (!accepted) {
      logger.error(`Semaphore SMS failed: ${bodyText}`);
      throw new HttpException(
        'SMS send failed — try again',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}

/** Resend transactional email. Kept, held by default (email OTP is dormant). */
class ResendEmailProvider implements OtpProvider {
  readonly name = 'resend';
  readonly isStub = false;

  constructor(
    private readonly apiKey: string,
    private readonly fromEmail: string | undefined,
  ) {}

  async send(email: string, code: string): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.fromEmail,
        to: email,
        subject: emailOtpSubject(),
        html: emailOtpHtml(code),
      }),
    });
    if (!response.ok) {
      logger.error(`Resend email failed: ${await response.text()}`);
      throw new HttpException(
        'Email send failed — try again',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }
}

function devModeOn(env: ProviderEnv): boolean {
  return env.OTP_DEV_MODE === 'true';
}

/**
 * What SMS provider an unconfigured environment gets.
 *
 * **Semaphore when its key is present, stub otherwise** — deliberately not a
 * flat `'stub'` default.
 *
 * A stub does not merely skip the send: `OtpService` returns the code in the
 * API response when `isStub` is true. `POST /auth/send-otp` is public, so a
 * production deploy that defaulted to the stub would hand the verification
 * code for *any* phone number back to whoever asked, which turns the COD
 * phone gate into a formality. Render currently sets no `OTP_SMS_PROVIDER`,
 * so a flat stub default would have shipped exactly that on the next deploy.
 *
 * Keying the default off the credential instead means the safe thing happens
 * without anyone remembering a new env var: a deploy holding a Semaphore key
 * keeps sending real SMS, and one with no key falls back to the stub — which
 * `assertSafeOtpConfig` then refuses to let boot in production.
 *
 * To hold Semaphore deliberately (e.g. while migrating to Brevo), set
 * `OTP_SMS_PROVIDER=stub` explicitly. That is a decision worth writing down
 * in the environment, not one worth inheriting from a default.
 */
function defaultSmsProvider(env: ProviderEnv): string {
  return env.SEMAPHORE_API_KEY ? 'semaphore' : 'stub';
}

/**
 * Refuses to boot a production environment whose OTP codes would come back in
 * the API response.
 *
 * Called from `main.ts` after `validateEnv`. `validateEnv` checks that a
 * *selected* provider has its key; this checks the outcome — the combination
 * that is unsafe is "production" plus "resolved to a stub", however it was
 * reached (dev mode left on, no key, an explicit stub selection).
 */
export function assertSafeOtpConfig(env: ProviderEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const sms = resolveSmsProvider(env);
  if (!sms.isStub) return;
  throw new Error(
    'Unsafe OTP configuration: the SMS provider resolved to the held stub in ' +
      'production, which returns the verification code in the API response ' +
      'and defeats phone verification entirely. Set SEMAPHORE_API_KEY (and ' +
      'unset OTP_DEV_MODE), or select a real provider with OTP_SMS_PROVIDER.',
  );
}

/**
 * Resolve the active SMS OTP provider. Default is the held stub. `OTP_DEV_MODE`
 * forces the stub regardless of selection (local dev). Selecting `semaphore`
 * without `SEMAPHORE_API_KEY` warns and falls back to the stub rather than
 * throwing at request time — validateEnv() catches that misconfiguration at
 * boot for any environment that actually selects it.
 */
export function resolveSmsProvider(
  env: ProviderEnv = process.env,
): OtpProvider {
  if (devModeOn(env)) return new StubOtpProvider('sms');
  const selected = (
    env.OTP_SMS_PROVIDER ?? defaultSmsProvider(env)
  ).toLowerCase();
  switch (selected) {
    case 'semaphore': {
      const apiKey = env.SEMAPHORE_API_KEY;
      if (!apiKey) {
        logger.warn(
          'OTP_SMS_PROVIDER=semaphore but SEMAPHORE_API_KEY is not set — using stub (no SMS sent).',
        );
        return new StubOtpProvider('sms');
      }
      return new SemaphoreSmsProvider(
        apiKey,
        env.SEMAPHORE_SENDER_NAME || 'CARTMAN',
      );
    }
    // case 'brevo': return new BrevoSmsProvider(env.BREVO_API_KEY!, ...);
    case 'stub':
      return new StubOtpProvider('sms');
    default:
      logger.warn(`Unknown OTP_SMS_PROVIDER "${selected}" — using stub.`);
      return new StubOtpProvider('sms');
  }
}

/** Resolve the active email OTP provider. Default is the held stub. */
export function resolveEmailProvider(
  env: ProviderEnv = process.env,
): OtpProvider {
  if (devModeOn(env)) return new StubOtpProvider('email');
  const selected = (env.OTP_EMAIL_PROVIDER ?? 'stub').toLowerCase();
  switch (selected) {
    case 'resend': {
      const apiKey = env.RESEND_API_KEY;
      if (!apiKey) {
        logger.warn(
          'OTP_EMAIL_PROVIDER=resend but RESEND_API_KEY is not set — using stub (no email sent).',
        );
        return new StubOtpProvider('email');
      }
      return new ResendEmailProvider(apiKey, env.RESEND_FROM_EMAIL);
    }
    // case 'brevo': return new BrevoEmailProvider(env.BREVO_API_KEY!, ...);
    case 'stub':
      return new StubOtpProvider('email');
    default:
      logger.warn(`Unknown OTP_EMAIL_PROVIDER "${selected}" — using stub.`);
      return new StubOtpProvider('email');
  }
}

/** One-line summary of the active OTP providers, for the boot log. */
export function describeOtpProviders(env: ProviderEnv = process.env): string {
  const tag = (p: OtpProvider) =>
    p.isStub ? `${p.name} (HELD — code returned in API response)` : p.name;
  return (
    `OTP delivery — SMS: ${tag(resolveSmsProvider(env))}; ` +
    `email: ${tag(resolveEmailProvider(env))}`
  );
}
