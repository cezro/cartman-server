import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Body,
  Param,
  UseGuards,
  ParseEnumPipe,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import { order_status } from '@prisma/client';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('food')
  @Roles('customer')
  placeFoodOrder(@CurrentUser() user: AuthenticatedUser, @Body() data: any) {
    return this.ordersService.placeFoodOrder(user.id, data);
  }

  @Post('errand')
  @Roles('customer')
  placeErrandOrder(@CurrentUser() user: AuthenticatedUser, @Body() data: any) {
    return this.ordersService.placeErrandOrder(user.id, data);
  }

  @Post('courier')
  @Roles('customer')
  placeCourierOrder(@CurrentUser() user: AuthenticatedUser, @Body() data: any) {
    return this.ordersService.placeCourierOrder(user.id, data);
  }

  @Get('history')
  @Roles('customer')
  getHistory(@CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.getHistory(user.id);
  }

  // Merchant operations
  @Patch(':id/accept')
  @Roles('merchant', 'admin')
  acceptOrder(@Param('id') id: string) {
    return this.ordersService.updateStatus(id, order_status.preparing);
  }

  @Patch(':id/ready')
  @Roles('merchant', 'admin')
  markReady(@Param('id') id: string) {
    return this.ordersService.updateStatus(id, order_status.ready_for_pickup);
  }

  // Rider operations
  @Patch(':id/claim')
  @Roles('rider')
  claimOrder(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.ordersService.claimOrder(id, user.id);
  }

  @Patch(':id/status')
  @Roles('rider')
  advanceRiderStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body('status') status: order_status,
  ) {
    return this.ordersService.advanceRiderStatus(id, user.id, status);
  }
}
