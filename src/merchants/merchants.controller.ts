import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { MerchantsService } from './merchants.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import {
  CreateMerchantDto,
  CreateMenuItemDto,
  UpdateMenuItemDto,
  UpdateMerchantStatusDto,
} from './dto/merchant.dto';

@Controller('merchants')
@UseGuards(JwtAuthGuard)
export class MerchantsController {
  constructor(private readonly merchantsService: MerchantsService) {}

  // Every write here is admin-only. These routes take the store id from the
  // URL and never check merchant_users, so a merchant role would let any
  // store owner create stores or reprice, sell out and delete another store's
  // menu. Store owners manage their own menu through the panel's member-scoped
  // RLS and merchant_* RPCs instead; no client calls these routes.
  @Post()
  @Roles('admin')
  createMerchant(@Body() data: CreateMerchantDto) {
    return this.merchantsService.createMerchant(data);
  }

  @Patch(':id/status')
  @Roles('admin') // Admin only
  updateMerchantStatus(
    @Param('id') id: string,
    @Body() body: UpdateMerchantStatusDto,
  ) {
    return this.merchantsService.updateMerchantStatus(id, body.is_open);
  }

  @Post(':id/menu-items')
  @Roles('admin')
  addMenuItem(@Param('id') id: string, @Body() data: CreateMenuItemDto) {
    return this.merchantsService.addMenuItem(id, data);
  }

  @Get(':id/menu-items')
  getMenuItems(@Param('id') id: string) {
    return this.merchantsService.getMenuItems(id);
  }

  @Put(':id/menu-items/:itemId')
  @Roles('admin')
  updateMenuItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() data: UpdateMenuItemDto,
  ) {
    return this.merchantsService.updateMenuItem(id, itemId, data);
  }

  @Patch(':id/menu-items/:itemId/stock')
  @Roles('admin')
  toggleStock(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body('in_stock') inStock: boolean,
  ) {
    return this.merchantsService.toggleStock(id, itemId, inStock);
  }

  @Delete(':id/menu-items/:itemId')
  @Roles('admin')
  deleteMenuItem(@Param('id') id: string, @Param('itemId') itemId: string) {
    return this.merchantsService.deleteMenuItem(id, itemId);
  }
}
