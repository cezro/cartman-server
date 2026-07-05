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
import { ToggleDutyDto } from './dto/toggle-duty.dto';
import { LogTelemetryDto } from './dto/log-telemetry.dto';

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
