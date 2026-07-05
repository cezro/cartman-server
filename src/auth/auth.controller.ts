import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OtpService } from './otp.service';
import {
  SendOtpDto,
  VerifyOtpDto,
  SendEmailOtpDto,
  VerifyEmailOtpDto,
} from './dto/otp.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from './jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly otpService: OtpService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Send a 6-digit OTP to a Philippine phone number.
   * Rate limited: max 3 per 15 min per phone.
   */
  @Post('send-otp')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send OTP to phone number (C-1.2)' })
  async sendOtp(
    @Body() dto: SendOtpDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.otpService.sendOtp(dto.phone, user.id);
  }

  /**
   * Verify a 6-digit OTP code. Sets phone_verified = true on success.
   */
  @Post('verify-otp')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify OTP code (C-1.2)' })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.otpService.verifyOtp(dto.phone, dto.code, user.id);
  }

  /**
   * Send a 6-digit OTP to an email address.
   * Rate limited: max 3 per 15 min per email.
   */
  @Post('send-email-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send OTP to email address (C-1.2)' })
  async sendEmailOtp(@Body() dto: SendEmailOtpDto) {
    return this.otpService.sendEmailOtp(dto.email);
  }

  /**
   * Verify a 6-digit email OTP code.
   */
  @Post('verify-email-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email OTP code (C-1.2)' })
  async verifyEmailOtp(@Body() dto: VerifyEmailOtpDto) {
    return this.otpService.verifyEmailOtp(dto.email, dto.code);
  }

  /**
   * Get the current authenticated user's profile.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  async getMe(@CurrentUser() user: AuthenticatedUser) {
    const profile = await this.prisma.profiles.findUnique({
      where: { id: user.id },
      include: {
        rider: true,
      },
    });
    return profile ? serializeProfile(profile) : profile;
  }
}

// Prisma returns bigint columns (`cart_points`, `wallet_centavos`) as JS
// BigInt, which Nest's default JSON serializer cannot stringify — this is
// what caused /auth/me to 500 on every live call. Centavo/points values are
// far under Number.MAX_SAFE_INTEGER, so converting to Number at the response
// boundary is safe. Mirrors the serializeOrder() precedent in
// src/orders/serialize-order.ts (Number, not String, for consistency).
// The nested `rider` relation has no BigInt columns (rating/acceptance_rate
// are Prisma Decimal, which JSON.stringify handles fine) — see
// prisma/schema.prisma's `riders` model — so it needs no conversion here.
function serializeProfile<T extends Record<string, any>>(profile: T): T {
  const out: Record<string, any> = { ...profile };
  for (const field of ['cart_points', 'wallet_centavos'] as const) {
    if (typeof out[field] === 'bigint') out[field] = Number(out[field]);
  }
  return out as T;
}
