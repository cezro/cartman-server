import {
  Injectable,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveSmsProvider, resolveEmailProvider } from './otp-providers';

type OtpChannel = 'sms' | 'email';

/**
 * OTP service — generates, stores, verifies 6-digit codes.
 * Delivery goes through the OtpProvider seam (see otp-providers.ts): SMS and
 * email providers (Semaphore / Resend) are HELD by default and the stub is
 * active, so no live send happens and the code is returned in the response
 * for QA. Swapping in a real provider (or Brevo) is a config/env change only.
 * Rate limit: max 3 codes per 15 min per identifier (C-1.2).
 */
@Injectable()
export class OtpService {
  private readonly RATE_LIMIT_WINDOW_MIN = 15;
  private readonly RATE_LIMIT_MAX = 3;
  private readonly OTP_EXPIRY_MIN = 10;
  private readonly MAX_ATTEMPTS = 5;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate a 6-digit OTP, hash it, store in otp_codes, send via Semaphore.
   */
  async sendOtp(
    phone: string,
    userId?: string,
  ): Promise<{ message: string; code?: string }> {
    const code = await this.generateAndStore(phone, 'sms', userId);

    // Held stub → nothing sent, code returned for QA. Live provider → real
    // send, code withheld from the response.
    const provider = resolveSmsProvider();
    await provider.send(phone, code);

    return {
      message: 'OTP sent successfully',
      ...(provider.isStub ? { code } : {}),
    };
  }

  /**
   * Generate a 6-digit OTP, hash it, store in otp_codes, deliver via the
   * active email provider (held stub by default — see otp-providers.ts).
   */
  async sendEmailOtp(
    email: string,
    userId?: string,
  ): Promise<{ message: string; code?: string }> {
    const code = await this.generateAndStore(email, 'email', userId);

    const provider = resolveEmailProvider();
    await provider.send(email, code);

    return {
      message: 'OTP sent successfully',
      ...(provider.isStub ? { code } : {}),
    };
  }

  /**
   * Verify a 6-digit OTP code against stored hash for a phone number.
   */
  async verifyOtp(
    phone: string,
    code: string,
    userId?: string,
  ): Promise<{ verified: boolean }> {
    return this.verify(phone, 'sms', code, userId);
  }

  /**
   * Verify a 6-digit OTP code against stored hash for an email address.
   */
  async verifyEmailOtp(
    email: string,
    code: string,
  ): Promise<{ verified: boolean }> {
    return this.verify(email, 'email', code);
  }

  /**
   * Shared rate-limit check + code generation + storage for both channels.
   */
  private async generateAndStore(
    identifier: string,
    channel: OtpChannel,
    userId?: string,
  ): Promise<string> {
    const windowStart = new Date(
      Date.now() - this.RATE_LIMIT_WINDOW_MIN * 60 * 1000,
    );
    const identifierField = channel === 'sms' ? 'phone' : 'email';

    const recentCount = await this.prisma.otp_codes.count({
      where: {
        [identifierField]: identifier,
        channel,
        created_at: { gte: windowStart },
      },
    });

    if (recentCount >= this.RATE_LIMIT_MAX) {
      throw new HttpException(
        `Too many OTP requests. Try again in ${this.RATE_LIMIT_WINDOW_MIN} minutes.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = randomInt(100000, 999999).toString();
    const codeHash = createHash('sha256')
      .update(`${identifier}:${code}`)
      .digest('hex');
    const expiresAt = new Date(Date.now() + this.OTP_EXPIRY_MIN * 60 * 1000);

    await this.prisma.otp_codes.create({
      data: {
        [identifierField]: identifier,
        channel,
        code_hash: codeHash,
        user_id: userId ?? undefined,
        expires_at: expiresAt,
      },
    });

    return code;
  }

  /**
   * Shared lookup + hash check + consume for both channels.
   */
  private async verify(
    identifier: string,
    channel: OtpChannel,
    code: string,
    callerUserId?: string,
  ): Promise<{ verified: boolean }> {
    const identifierField = channel === 'sms' ? 'phone' : 'email';
    const codeHash = createHash('sha256')
      .update(`${identifier}:${code}`)
      .digest('hex');

    const otpRecord = await this.prisma.otp_codes.findFirst({
      where: {
        [identifierField]: identifier,
        channel,
        consumed: false,
        expires_at: { gte: new Date() },
      },
      orderBy: { created_at: 'desc' },
    });

    if (!otpRecord) {
      throw new BadRequestException('No valid OTP found. Request a new one.');
    }

    if (
      callerUserId &&
      otpRecord.user_id &&
      otpRecord.user_id !== callerUserId
    ) {
      throw new BadRequestException('OTP does not belong to this user');
    }

    if (otpRecord.attempts >= this.MAX_ATTEMPTS) {
      throw new BadRequestException(
        'Too many failed attempts. Request a new OTP.',
      );
    }

    // Deliberately outside the transaction below: a wrong guess must burn an
    // attempt even though the verify goes on to throw. Roll this back with
    // the rest and MAX_ATTEMPTS could never be reached.
    await this.prisma.otp_codes.update({
      where: { id: otpRecord.id },
      data: { attempts: { increment: 1 } },
    });

    if (otpRecord.code_hash !== codeHash) {
      throw new BadRequestException('Invalid OTP code.');
    }

    // Only the SMS channel maps onto a profile update: `profiles` has a
    // `phone`/`phone_verified` column pair but no `email` column, so doing
    // this unconditionally for the email channel would both (a) incorrectly
    // flip phone_verified based on an email code and (b) throw a Prisma
    // error writing a nonexistent `profiles.email` column.
    const targetUserId = callerUserId ?? otpRecord.user_id;
    const linksProfile = Boolean(targetUserId) && channel === 'sms';

    // BUG-013. Consuming the code and stamping the profile are one unit of
    // work. They used to be two statements in sequence, and the second one can
    // fail: `profiles.phone` is UNIQUE, so verifying a number that another
    // account already holds raises P2002. The consume had committed by then,
    // so the customer got a 500 *and* lost a code that was never wrong — the
    // next attempt found no unconsumed row and was told "No valid OTP found",
    // inside the code's own 10-minute window. Either both writes land or
    // neither does, and a spent code now always means a genuinely used one.
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.otp_codes.update({
          where: { id: otpRecord.id },
          data: { consumed: true },
        });

        if (linksProfile) {
          // Proving the number is what makes it yours. Another account that
          // only typed it at sign-up, never verified, gives it up here; it
          // used to hold the UNIQUE slot, so the real owner could never
          // verify. A verified holder still wins (the 409 below).
          await tx.profiles.updateMany({
            where: {
              phone: identifier,
              phone_verified: false,
              NOT: { id: targetUserId as string },
            },
            data: { phone: null },
          });
          await tx.profiles.update({
            where: { id: targetUserId as string },
            data: { phone_verified: true, phone: identifier },
          });
        }
      });
    } catch (error) {
      // One phone number, one account — that is what the UNIQUE constraint
      // says, so say it out loud instead of letting it read as a server fault.
      // The clients render a JSON `message` in preference to their own
      // fallback, so this reaches the customer as written.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'That number is already verified on another Cartman account. ' +
            'Use a different number, or sign in to the account that has it.',
        );
      }
      throw error;
    }

    return { verified: true };
  }
}
