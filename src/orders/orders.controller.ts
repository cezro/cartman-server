import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { OrdersService, WALLET_LOCK_FLOOR } from './orders.service';
import { FeedService } from './feed.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import {
  CancelOrderDto,
  PlaceMerchantOrderDto,
  PlaceErrandOrderDto,
  PlaceMultiStopOrderDto,
  PlacePickupDropoffOrderDto,
  UpdateOrderStatusDto,
} from './dto/place-order.dto';

function parseOptionalFloat(value?: string): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly feedService: FeedService,
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
  ) {}

  @Post('food')
  @Roles('customer')
  placeFoodOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() data: PlaceMerchantOrderDto,
  ) {
    return this.ordersService.placeFoodOrder(user.id, data);
  }

  @Post('grocery')
  @Roles('customer')
  placeGroceryOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() data: PlaceMerchantOrderDto,
  ) {
    return this.ordersService.placeGroceryOrder(user.id, data);
  }

  @Post('errand')
  @Roles('customer')
  placeErrandOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() data: PlaceErrandOrderDto,
  ) {
    return this.ordersService.placeErrandOrder(user.id, data);
  }

  @Post('courier')
  @Roles('customer')
  placeCourierOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() data: PlacePickupDropoffOrderDto,
  ) {
    return this.ordersService.placeCourierOrder(user.id, data);
  }

  @Post('ride')
  @Roles('customer')
  placeRideOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() data: PlacePickupDropoffOrderDto,
  ) {
    return this.ordersService.placeRideOrder(user.id, data);
  }

  @Post('multi-stop')
  @Roles('customer')
  placeMultiStopOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() data: PlaceMultiStopOrderDto,
  ) {
    return this.ordersService.placeMultiStopOrder(user.id, data);
  }

  @Get('history')
  @Roles('customer')
  getHistory(@CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.getHistory(user.id);
  }

  @Patch(':id/cancel')
  @Roles('customer')
  cancelOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: CancelOrderDto,
  ) {
    return this.ordersService.cancelOrder(id, user.id, body.reason);
  }

  // Merchant operations
  @Patch(':id/accept')
  @Roles('merchant', 'admin')
  acceptOrder(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.ordersService.merchantAccept(id, user);
  }

  @Patch(':id/ready')
  @Roles('merchant', 'admin')
  markReady(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.ordersService.merchantMarkReady(id, user);
  }

  @Patch(':id/reject')
  @Roles('merchant', 'admin')
  rejectOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: CancelOrderDto,
  ) {
    return this.ordersService.merchantReject(id, user, body.reason);
  }

  // Rider operations
  @Get('feed')
  @Roles('rider')
  async getFeed(
    @CurrentUser() user: AuthenticatedUser,
    @Query('lat') latParam?: string,
    @Query('lng') lngParam?: string,
  ) {
    const rider = await this.prisma.riders.findUnique({
      where: { id: user.id },
    });
    if (!rider?.is_active) {
      throw new ForbiddenException('Go on duty to see orders');
    }

    const netCash = await this.ledgerService.getNetCash(user.id);
    if (netCash <= WALLET_LOCK_FLOOR) {
      throw new ForbiddenException(
        'Wallet locked — remit cash before accepting orders',
      );
    }

    const lat = parseOptionalFloat(latParam);
    const lng = parseOptionalFloat(lngParam);
    return this.feedService.rankedFeed(user.id, lat, lng);
  }

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
    @Body() body: UpdateOrderStatusDto,
  ) {
    return this.ordersService.advanceRiderStatus(id, user.id, body.status);
  }
}
