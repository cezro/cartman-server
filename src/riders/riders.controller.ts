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

@Controller('riders')
@UseGuards(JwtAuthGuard)
export class RidersController {
  constructor(private readonly ridersService: RidersService) {}

  @Post()
  @Roles('rider', 'admin')
  createRider(@CurrentUser() user: AuthenticatedUser, @Body() data: any) {
    return this.ridersService.createRider(user.id, data);
  }

  @Patch(':id/activate')
  @Roles('admin')
  activateRider(@Param('id') id: string, @Body('is_active') isActive: boolean) {
    return this.ridersService.activateRider(id, isActive);
  }

  @Patch('me/duty')
  @Roles('rider')
  toggleDuty(
    @CurrentUser() user: AuthenticatedUser,
    @Body('is_active') isActive: boolean,
  ) {
    return this.ridersService.toggleDuty(user.id, isActive);
  }

  @Post('me/telemetry')
  @Roles('rider')
  logTelemetry(
    @CurrentUser() user: AuthenticatedUser,
    @Body('locations') locations: any[],
  ) {
    return this.ridersService.logTelemetry(user.id, locations);
  }

  @Get('me/history')
  @Roles('rider')
  getDeliveryHistory(@CurrentUser() user: AuthenticatedUser) {
    return this.ridersService.getDeliveryHistory(user.id);
  }
}
