import {
  Injectable,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * OTP service — generates, stores, verifies 6-digit codes.
 * Sends SMS via Semaphore (PH-local gateway).
 * Rate limit: max 3 codes per 15 min per phone (C-1.2).
 */
@Injectable()
export class OtpService {
  private readonly RATE_LIMIT_WINDOW_MIN = 15;
  private readonly RATE_LIMIT_MAX = 3;
  private readonly OTP_EXPIRY_MIN = 5;
  private readonly MAX_ATTEMPTS = 5;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate a 6-digit OTP, hash it, store in otp_codes, send via Semaphore.
   */
  async sendOtp(phone: string, userId?: string): Promise<{ message: string }> {
    // Rate limit check
    const windowStart = new Date(
      Date.now() - this.RATE_LIMIT_WINDOW_MIN * 60 * 1000,
    );
    const recentCount = await this.prisma.otp_codes.count({
      where: {
        phone,
        created_at: { gte: windowStart },
      },
    });

    if (recentCount >= this.RATE_LIMIT_MAX) {
      throw new HttpException(
        `Too many OTP requests. Try again in ${this.RATE_LIMIT_WINDOW_MIN} minutes.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Generate 6-digit code
    const code = randomInt(100000, 999999).toString();
    const codeHash = createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(
      Date.now() + this.OTP_EXPIRY_MIN * 60 * 1000,
    );

    // Store in DB
    await this.prisma.otp_codes.create({
      data: {
        phone,
        code_hash: codeHash,
        user_id: userId ?? undefined,
        expires_at: expiresAt,
      },
    });

    // Send via Semaphore (or return code in dev mode)
    const devMode = process.env.OTP_DEV_MODE === 'true';

    if (!devMode) {
      await this.sendSemaphoreSms(phone, code);
    }

    return {
      message: 'OTP sent successfully',
      ...(devMode ? { code } : {}),
    };
  }

  /**
   * Verify a 6-digit OTP code against stored hash.
   */
  async verifyOtp(
    phone: string,
    code: string,
  ): Promise<{ verified: boolean }> {
    const codeHash = createHash('sha256').update(code).digest('hex');

    // Find the latest unconsumed OTP for this phone
    const otpRecord = await this.prisma.otp_codes.findFirst({
      where: {
        phone,
        consumed: false,
        expires_at: { gte: new Date() },
      },
      orderBy: { created_at: 'desc' },
    });

    if (!otpRecord) {
      throw new BadRequestException('No valid OTP found. Request a new one.');
    }

    // Check max attempts
    if (otpRecord.attempts >= this.MAX_ATTEMPTS) {
      throw new BadRequestException(
        'Too many failed attempts. Request a new OTP.',
      );
    }

    // Increment attempt counter
    await this.prisma.otp_codes.update({
      where: { id: otpRecord.id },
      data: { attempts: { increment: 1 } },
    });

    if (otpRecord.code_hash !== codeHash) {
      throw new BadRequestException('Invalid OTP code.');
    }

    // Mark as consumed
    await this.prisma.otp_codes.update({
      where: { id: otpRecord.id },
      data: { consumed: true },
    });

    // Set phone_verified on the user's profile
    if (otpRecord.user_id) {
      await this.prisma.profiles.update({
        where: { id: otpRecord.user_id },
        data: { phone_verified: true, phone },
      });
    }

    return { verified: true };
  }

  /**
   * Send SMS via Semaphore API.
   */
  private async sendSemaphoreSms(
    phone: string,
    code: string,
  ): Promise<void> {
    const apiKey = process.env.SEMAPHORE_API_KEY;
    const senderName = process.env.SEMAPHORE_SENDER_NAME || 'CARTMAN';

    if (!apiKey) {
      console.warn('SEMAPHORE_API_KEY not set — skipping SMS send');
      return;
    }

    const message = `Your Cartman verification code is: ${code}. Valid for 5 minutes.`;

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
    }
  }
}
