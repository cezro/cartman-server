import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { RidersService } from './riders.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { CreateRiderDto } from './dto/create-rider.dto';
import { OnboardRiderDto } from './dto/onboard-rider.dto';
import { ToggleDutyDto } from './dto/toggle-duty.dto';
import { LogTelemetryDto } from './dto/log-telemetry.dto';
import { SubmitVerificationDto } from './dto/submit-verification.dto';

@Controller('riders')
@UseGuards(JwtAuthGuard)
export class RidersController {
  constructor(private readonly ridersService: RidersService) {}

  @Post()
  @Roles('rider', 'admin')
  createRider(
    @CurrentUser() user: AuthenticatedUser,
    @Body() data: CreateRiderDto,
  ) {
    return this.ridersService.createRider(user.id, data);
  }

  /**
   * Self-service rider onboarding — the only way a Google account can become a
   * rider (see RidersService.onboardRider for why).
   *
   * Deliberately has NO @Roles(): the caller is by definition still role
   * 'customer', so @Roles('rider') would make this unreachable. Authentication
   * is still required (the controller-level JwtAuthGuard plus the global one),
   * and the promoted id comes from the verified JWT via @CurrentUser — never
   * from the body — so a caller can only ever promote themselves. This grants
   * exactly what the email/password rider sign-up form already grants by
   * self-declaring `role: 'rider'` in its signup metadata, and the resulting
   * rider is unverified + off duty until an admin approves them.
   */
  @Post('onboard')
  onboardRider(
    @CurrentUser() user: AuthenticatedUser,
    @Body() data: OnboardRiderDto,
  ) {
    return this.ridersService.onboardRider(user.id, data);
  }

  /**
   * Attach a document to the caller's own verification review.
   *
   * `@Roles('rider')` is correct here where it would have been wrong on
   * /onboard: by this point the caller is already a rider, they are just not
   * an approved one. The review is looked up from the JWT, never from the
   * body, so a rider can only ever submit against their own.
   */
  @Post('me/verification')
  @Roles('rider')
  submitVerification(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SubmitVerificationDto,
  ) {
    return this.ridersService.submitVerificationDocument(user.id, body);
  }

  @Patch(':id/activate')
  @Roles('admin')
  activateRider(@Param('id') id: string, @Body() body: ToggleDutyDto) {
    return this.ridersService.activateRider(id, body.is_active);
  }

  @Patch('me/duty')
  @Roles('rider')
  toggleDuty(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ToggleDutyDto,
  ) {
    return this.ridersService.toggleDuty(user.id, body.is_active);
  }

  @Post('me/telemetry')
  @Roles('rider')
  logTelemetry(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: LogTelemetryDto,
  ) {
    return this.ridersService.logTelemetry(user.id, body.locations);
  }

  @Get('me/history')
  @Roles('rider')
  getDeliveryHistory(@CurrentUser() user: AuthenticatedUser) {
    return this.ridersService.getDeliveryHistory(user.id);
  }
}
