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

  @Post()
  @Roles('merchant', 'admin') // Depending on who can create
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
  @Roles('merchant', 'admin')
  addMenuItem(@Param('id') id: string, @Body() data: CreateMenuItemDto) {
    return this.merchantsService.addMenuItem(id, data);
  }

  @Get(':id/menu-items')
  getMenuItems(@Param('id') id: string) {
    return this.merchantsService.getMenuItems(id);
  }

  @Put(':id/menu-items/:itemId')
  @Roles('merchant', 'admin')
  updateMenuItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() data: UpdateMenuItemDto,
  ) {
    return this.merchantsService.updateMenuItem(id, itemId, data);
  }

  @Patch(':id/menu-items/:itemId/stock')
  @Roles('merchant', 'admin')
  toggleStock(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body('in_stock') inStock: boolean,
  ) {
    return this.merchantsService.toggleStock(id, itemId, inStock);
  }

  @Delete(':id/menu-items/:itemId')
  @Roles('merchant', 'admin')
  deleteMenuItem(@Param('id') id: string, @Param('itemId') itemId: string) {
    return this.merchantsService.deleteMenuItem(id, itemId);
  }
}
