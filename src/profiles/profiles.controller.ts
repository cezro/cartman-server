import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ProfilesService } from './profiles.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';

@Controller('profiles')
@UseGuards(JwtAuthGuard)
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get('me')
  getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.profilesService.getProfile(user.id);
  }

  @Get('me/addresses')
  getAddresses(@CurrentUser() user: AuthenticatedUser) {
    return this.profilesService.getAddresses(user.id);
  }

  @Post('me/addresses')
  createAddress(@CurrentUser() user: AuthenticatedUser, @Body() data: any) {
    return this.profilesService.createAddress(user.id, data);
  }

  @Put('me/addresses/:id')
  updateAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() data: any,
  ) {
    return this.profilesService.updateAddress(user.id, id, data);
  }

  @Delete('me/addresses/:id')
  deleteAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.profilesService.deleteAddress(user.id, id);
  }
}
