import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { OtpService } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';

function hashOtp(identifier: string, code: string): string {
  return createHash('sha256').update(`${identifier}:${code}`).digest('hex');
}

interface OtpRecord {
  id: string;
  code_hash: string;
  attempts: number;
  user_id: string | null;
}

type CountFn = jest.Mock<Promise<number>, [Record<string, unknown>]>;
type CreateFn = jest.Mock<Promise<unknown>, [Record<string, unknown>]>;
type FindFirstFn = jest.Mock<
  Promise<OtpRecord | null>,
  [Record<string, unknown>]
>;
type UpdateFn = jest.Mock<Promise<unknown>, [Record<string, unknown>]>;
type TransactionFn = jest.Mock<Promise<unknown>, [TransactionCallback]>;
type TransactionCallback = (tx: unknown) => Promise<unknown>;
type FetchFn = jest.Mock<
  Promise<{ ok: boolean; text: () => Promise<string> }>,
  [string, RequestInit]
>;

describe('OtpService', () => {
  let service: OtpService;
  let prisma: {
    otp_codes: {
      count: CountFn;
      create: CreateFn;
      findFirst: FindFirstFn;
      update: UpdateFn;
    };
    profiles: {
      update: UpdateFn;
    };
    $transaction: TransactionFn;
  };
  let fetchMock: FetchFn;

  beforeEach(() => {
    prisma = {
      otp_codes: {
        count: jest
          .fn<Promise<number>, [Record<string, unknown>]>()
          .mockResolvedValue(0),
        create: jest
          .fn<Promise<unknown>, [Record<string, unknown>]>()
          .mockResolvedValue({}),
        findFirst: jest.fn<
          Promise<OtpRecord | null>,
          [Record<string, unknown>]
        >(),
        update: jest
          .fn<Promise<unknown>, [Record<string, unknown>]>()
          .mockResolvedValue({}),
      },
      profiles: {
        update: jest
          .fn<Promise<unknown>, [Record<string, unknown>]>()
          .mockResolvedValue({}),
      },
      // Interactive-transaction stub: runs the callback against the same
      // mocked client, so every existing assertion on prisma.otp_codes /
      // prisma.profiles still sees the writes. Rollback itself is Postgres's
      // job — what these tests pin is that the writes are handed to
      // $transaction at all, and that a failure inside it surfaces correctly.
      $transaction: jest.fn<Promise<unknown>, [TransactionCallback]>(
        async (cb: TransactionCallback) => cb(prisma),
      ),
    };
    service = new OtpService(prisma as unknown as PrismaService);

    fetchMock = jest
      .fn<
        Promise<{ ok: boolean; text: () => Promise<string> }>,
        [string, RequestInit]
      >()
      .mockResolvedValue({
        ok: true,
        // A real Semaphore accept: an ARRAY of message objects. (Resend's
        // path never reads the body, so sharing this default is safe.)
        text: () => Promise.resolve('[{"message_id": 187067302}]'),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    delete process.env.OTP_DEV_MODE;
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.RESEND_FROM_EMAIL = 'noreply@cartmanph.com';
    process.env.SEMAPHORE_API_KEY = 'test-semaphore-key';
    // Most tests exercise the live provider path; the held-stub default is
    // covered explicitly in its own describe block below.
    process.env.OTP_SMS_PROVIDER = 'semaphore';
    process.env.OTP_EMAIL_PROVIDER = 'resend';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.OTP_SMS_PROVIDER;
    delete process.env.OTP_EMAIL_PROVIDER;
    delete process.env.OTP_DEV_MODE;
    delete process.env.SEMAPHORE_API_KEY;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
  });

  describe('sendEmailOtp', () => {
    it('stores an otp_codes row with channel "email" and the email field set', async () => {
      await service.sendEmailOtp('rider@example.com');

      expect(prisma.otp_codes.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'rider@example.com',
            channel: 'email',
          }) as Record<string, unknown>,
        }),
      );
    });

    it('sends the code via the Resend API', async () => {
      await service.sendEmailOtp('rider@example.com');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.resend.com/emails',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-resend-key',
            'Content-Type': 'application/json',
          }) as Record<string, unknown>,
        }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
        from: string;
        to: string;
      };
      expect(body.from).toBe('noreply@cartmanph.com');
      expect(body.to).toBe('rider@example.com');
    });

    it('does not call Resend and returns the code when OTP_DEV_MODE=true', async () => {
      process.env.OTP_DEV_MODE = 'true';

      const result = await service.sendEmailOtp('rider@example.com');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.code).toBeDefined();
    });

    it('rate limits after 3 requests within 15 minutes for the same email', async () => {
      prisma.otp_codes.count.mockResolvedValue(3);

      await expect(service.sendEmailOtp('rider@example.com')).rejects.toThrow(
        HttpException,
      );
    });
  });

  describe('verifyEmailOtp', () => {
    it('verifies a correct code and marks it consumed', async () => {
      const code = '123456';
      const codeHash = hashOtp('rider@example.com', code);

      prisma.otp_codes.findFirst.mockResolvedValue({
        id: 'otp-1',
        code_hash: codeHash,
        attempts: 0,
        user_id: null,
      });

      const result = await service.verifyEmailOtp('rider@example.com', code);

      expect(result).toEqual({ verified: true });
      expect(prisma.otp_codes.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'otp-1' },
          data: { consumed: true },
        }),
      );
    });

    it('rejects an incorrect code', async () => {
      prisma.otp_codes.findFirst.mockResolvedValue({
        id: 'otp-1',
        code_hash: 'not-a-match',
        attempts: 0,
        user_id: null,
      });

      await expect(
        service.verifyEmailOtp('rider@example.com', '000000'),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not touch profiles even when bound to an authenticated user (no profiles.email column)', async () => {
      const code = '555666';
      const codeHash = hashOtp('rider@example.com', code);

      prisma.otp_codes.findFirst.mockResolvedValue({
        id: 'otp-6',
        code_hash: codeHash,
        attempts: 0,
        user_id: 'user-1',
      });

      const result = await service.verifyEmailOtp('rider@example.com', code);

      expect(result).toEqual({ verified: true });
      expect(prisma.profiles.update).not.toHaveBeenCalled();
    });
  });

  describe('sendOtp (existing SMS flow, must keep working)', () => {
    it('still stores a phone/sms row and sends via Semaphore', async () => {
      await service.sendOtp('+639171234567');

      expect(prisma.otp_codes.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            phone: '+639171234567',
            channel: 'sms',
          }) as Record<string, unknown>,
        }),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.semaphore.co/api/v4/messages',
        expect.any(Object),
      );
    });
  });

  describe('verifyOtp (existing SMS flow, must keep working)', () => {
    it('still verifies a correct phone code', async () => {
      const code = '654321';
      const codeHash = hashOtp('+639171234567', code);

      prisma.otp_codes.findFirst.mockResolvedValue({
        id: 'otp-2',
        code_hash: codeHash,
        attempts: 0,
        user_id: null,
      });

      const result = await service.verifyOtp('+639171234567', code);

      expect(result).toEqual({ verified: true });
    });
  });

  describe('verifyOtp bound to authenticated user', () => {
    it('sets phone_verified: true and stores the phone on the profile', async () => {
      const code = '111222';
      const codeHash = hashOtp('+639171234567', code);

      prisma.otp_codes.findFirst.mockResolvedValue({
        id: 'otp-3',
        code_hash: codeHash,
        attempts: 0,
        user_id: 'user-1',
      });

      const result = await service.verifyOtp('+639171234567', code, 'user-1');

      expect(result).toEqual({ verified: true });
      expect(prisma.profiles.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          data: expect.objectContaining({
            phone_verified: true,
            phone: '+639171234567',
          }) as Record<string, unknown>,
        }),
      );
    });

    it('rejects when the stored user_id differs from the caller id', async () => {
      const code = '333444';
      const codeHash = hashOtp('+639171234567', code);

      prisma.otp_codes.findFirst.mockResolvedValue({
        id: 'otp-4',
        code_hash: codeHash,
        attempts: 0,
        user_id: 'user-1',
      });

      await expect(
        service.verifyOtp('+639171234567', code, 'user-2'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.verifyOtp('+639171234567', code, 'user-2'),
      ).rejects.toThrow('OTP does not belong to this user');
    });
  });

  describe('BUG-013 — a failed profile write must not spend the code', () => {
    // The reported sequence was: correct code → 500 → the same code then reads
    // as invalid inside its own 10-minute window → repeated retries → 429.
    //
    // Root cause: verify() marked the row consumed and *then* wrote
    // profiles.phone. `profiles.phone` is UNIQUE (20260630000100_schema.sql:60)
    // and a tester has one phone number but several accounts, so the second
    // account's write raised P2002. AllExceptionsFilter turned that into a bare
    // 500, and because the consume had already committed, the retry's
    // findFirst({consumed: false}) matched nothing — hence "invalid" for a code
    // that was never wrong.
    const code = '246810';
    const phone = '+639171234567';

    function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
      return new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`phone`)',
        {
          code: 'P2002',
          clientVersion: '6.0.0',
          meta: { target: ['phone'] },
        },
      );
    }

    beforeEach(() => {
      prisma.otp_codes.findFirst.mockResolvedValue({
        id: 'otp-bug013',
        code_hash: hashOtp(phone, code),
        attempts: 0,
        user_id: 'user-1',
      });
    });

    it('answers 409 with an actionable message when the number belongs to another account', async () => {
      prisma.profiles.update.mockRejectedValue(uniqueViolation());

      await expect(
        service.verifyOtp(phone, code, 'user-1'),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(service.verifyOtp(phone, code, 'user-1')).rejects.toThrow(
        /already verified on another Cartman account/i,
      );
    });

    it('hands the consume and the profile write to a single transaction', async () => {
      await service.verifyOtp(phone, code, 'user-1');

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('never marks the code consumed outside the transaction', async () => {
      // $transaction rejects without running the callback, standing in for a
      // rolled-back transaction. Nothing may have escaped it.
      prisma.$transaction.mockRejectedValue(uniqueViolation());

      await expect(service.verifyOtp(phone, code, 'user-1')).rejects.toThrow();

      const consumeWrites = prisma.otp_codes.update.mock.calls.filter(
        (call) =>
          (call[0] as { data?: { consumed?: boolean } }).data?.consumed ===
          true,
      );
      expect(consumeWrites).toHaveLength(0);
    });

    it('still burns an attempt on a wrong code, since that write is deliberately outside the transaction', async () => {
      // Brute-force protection must survive a rejected verify — if the
      // increment were inside the transaction, every wrong guess would roll
      // its own counter back and MAX_ATTEMPTS would never be reached.
      await expect(
        service.verifyOtp(phone, '000000', 'user-1'),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.otp_codes.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'otp-bug013' },
          data: { attempts: { increment: 1 } },
        }),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('lets an unrecognised failure through as a 500 rather than claiming the code was wrong', async () => {
      prisma.profiles.update.mockRejectedValue(new Error('connection reset'));

      await expect(service.verifyOtp(phone, code, 'user-1')).rejects.toThrow(
        'connection reset',
      );
      await expect(
        service.verifyOtp(phone, code, 'user-1'),
      ).rejects.not.toBeInstanceOf(BadRequestException);
    });
  });

  describe('rate limiting and attempt/expiry behavior', () => {
    it('rejects the 4th send within the 15 minute window with HttpException 429', async () => {
      prisma.otp_codes.count.mockResolvedValue(3);

      await expect(service.sendOtp('+639171234567')).rejects.toThrow(
        HttpException,
      );
      await expect(service.sendOtp('+639171234567')).rejects.toMatchObject({
        status: 429,
      });
    });

    it('increments attempts and rejects on a wrong code', async () => {
      prisma.otp_codes.findFirst.mockResolvedValue({
        id: 'otp-5',
        code_hash: 'not-a-match',
        attempts: 0,
        user_id: null,
      });

      await expect(
        service.verifyOtp('+639171234567', '000000'),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.otp_codes.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'otp-5' },
          data: { attempts: { increment: 1 } },
        }),
      );
    });

    it('rejects an expired code (no matching non-expired record found)', async () => {
      prisma.otp_codes.findFirst.mockResolvedValue(null);

      await expect(
        service.verifyOtp('+639171234567', '654321'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.verifyOtp('+639171234567', '654321'),
      ).rejects.toThrow('No valid OTP found. Request a new one.');
    });
  });

  describe('provider selection and the code-in-response rule', () => {
    // The stub does not merely skip the send — OtpService returns the code in
    // the API response, and POST /auth/send-otp is public. "Which provider is
    // active" is therefore a security question, which is why the default keys
    // off the credential instead of being a flat 'stub'.

    it('an unset selection uses Semaphore when its key is present, and withholds the code', async () => {
      delete process.env.OTP_SMS_PROVIDER;

      const result = await service.sendOtp('+639171234567');

      expect(fetchMock).toHaveBeenCalled();
      expect(result.code).toBeUndefined();
    });

    it('an unset selection with no key falls back to the stub', async () => {
      delete process.env.OTP_SMS_PROVIDER;
      delete process.env.SEMAPHORE_API_KEY;

      const result = await service.sendOtp('+639171234567');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.code).toBeDefined();
    });

    it('the stub can still be selected explicitly, even with a key set', async () => {
      // How a deliberate hold is expressed — e.g. while migrating to Brevo.
      process.env.OTP_SMS_PROVIDER = 'stub';

      const result = await service.sendOtp('+639171234567');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.code).toBeDefined();
    });

    it('sendEmailOtp defaults to the held stub — the email path is dormant', async () => {
      delete process.env.OTP_EMAIL_PROVIDER;

      const result = await service.sendEmailOtp('rider@example.com');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.code).toBeDefined();
    });
  });

  describe('sendSemaphoreSms failure surfacing', () => {
    it('throws HttpException 502 when Semaphore responds non-ok and the API key is set', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        text: () => Promise.resolve('Semaphore error body'),
      });

      await expect(service.sendOtp('+639171234567')).rejects.toThrow(
        HttpException,
      );
      await expect(service.sendOtp('+639171234567')).rejects.toMatchObject({
        status: 502,
      });
    });

    it('throws 502 when Semaphore answers HTTP 200 with a validation-error body (invalid sender name)', async () => {
      // Observed live 2026-07-18: an unregistered sender name comes back as
      // HTTP 200 + {"sendername":[...]} — no message sent, no credit spent.
      // response.ok alone would report success while the SMS never left.
      fetchMock.mockResolvedValue({
        ok: true,
        text: () =>
          Promise.resolve(
            '{"sendername":["The selected sendername is invalid."]}',
          ),
      });

      await expect(service.sendOtp('+639171234567')).rejects.toMatchObject({
        status: 502,
      });
    });

    it('throws 502 when Semaphore answers 200 with an empty or non-JSON body', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(''),
      });

      await expect(service.sendOtp('+639171234567')).rejects.toMatchObject({
        status: 502,
      });
    });

    it('accepts a real Semaphore response: HTTP 200 with a message array', async () => {
      await expect(service.sendOtp('+639171234567')).resolves.toMatchObject({
        message: 'OTP sent successfully',
      });
    });
  });
});
