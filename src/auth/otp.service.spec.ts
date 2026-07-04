import { createHash } from 'crypto';
import { OtpService } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, HttpException } from '@nestjs/common';

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
    };
    service = new OtpService(prisma as unknown as PrismaService);

    fetchMock = jest
      .fn<
        Promise<{ ok: boolean; text: () => Promise<string> }>,
        [string, RequestInit]
      >()
      .mockResolvedValue({ ok: true, text: () => Promise.resolve('') });
    global.fetch = fetchMock as unknown as typeof fetch;

    delete process.env.OTP_DEV_MODE;
    process.env.RESEND_API_KEY = 'test-resend-key';
    process.env.RESEND_FROM_EMAIL = 'noreply@cartmanph.com';
    process.env.SEMAPHORE_API_KEY = 'test-semaphore-key';
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
  });
});
