import {
  Injectable,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

type OtpChannel = 'sms' | 'email';

/**
 * OTP service — generates, stores, verifies 6-digit codes.
 * Sends SMS via Semaphore (PH-local gateway) or email via Resend.
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

    const devMode = process.env.OTP_DEV_MODE === 'true';
    if (!devMode) {
      await this.sendSemaphoreSms(phone, code);
    }

    return { message: 'OTP sent successfully', ...(devMode ? { code } : {}) };
  }

  /**
   * Generate a 6-digit OTP, hash it, store in otp_codes, send via Resend.
   */
  async sendEmailOtp(
    email: string,
    userId?: string,
  ): Promise<{ message: string; code?: string }> {
    const code = await this.generateAndStore(email, 'email', userId);

    const devMode = process.env.OTP_DEV_MODE === 'true';
    if (!devMode) {
      await this.sendResendEmail(email, code);
    }

    return { message: 'OTP sent successfully', ...(devMode ? { code } : {}) };
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

    await this.prisma.otp_codes.update({
      where: { id: otpRecord.id },
      data: { attempts: { increment: 1 } },
    });

    if (otpRecord.code_hash !== codeHash) {
      throw new BadRequestException('Invalid OTP code.');
    }

    await this.prisma.otp_codes.update({
      where: { id: otpRecord.id },
      data: { consumed: true },
    });

    const targetUserId = callerUserId ?? otpRecord.user_id;
    if (targetUserId) {
      const profileUpdate: Record<string, unknown> = { phone_verified: true };
      profileUpdate[identifierField] = identifier;
      await this.prisma.profiles.update({
        where: { id: targetUserId },
        data: profileUpdate,
      });
    }

    return { verified: true };
  }

  /**
   * Send SMS via Semaphore API.
   */
  private async sendSemaphoreSms(phone: string, code: string): Promise<void> {
    const apiKey = process.env.SEMAPHORE_API_KEY;
    const senderName = process.env.SEMAPHORE_SENDER_NAME || 'CARTMAN';

    if (!apiKey) {
      console.warn('SEMAPHORE_API_KEY not set — skipping SMS send');
      return;
    }

    const message = `Your Cartman verification code is: ${code}. Valid for 10 minutes.`;

    const response = await fetch('https://api.semaphore.co/api/v4/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apikey: apiKey,
        number: phone.replace('+', ''),
        message,
        sendername: senderName,
      }),
    });

    if (!response.ok) {
      console.error('Semaphore SMS failed:', await response.text());
      throw new HttpException(
        'SMS send failed — try again',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * Send email via Resend API.
   */
  private async sendResendEmail(email: string, code: string): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.RESEND_FROM_EMAIL;

    if (!apiKey) {
      console.warn('RESEND_API_KEY not set — skipping email send');
      return;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: email,
        subject: 'Your Cartman verification code',
        html: `Your Cartman verification code is: ${code}. Valid for 10 minutes.`,
      }),
    });

    if (!response.ok) {
      console.error('Resend email failed:', await response.text());
    }
  }
}
