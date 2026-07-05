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
import { Throttle } from '@nestjs/throttler';
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
import { serializeProfile } from '../common/serialize-profile';

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
  // Defense-in-depth on top of OtpService's own per-phone DB rate limit
  // (max 3/15min) — this is a coarser per-IP guard against hammering the
  // endpoint itself.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
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
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
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
