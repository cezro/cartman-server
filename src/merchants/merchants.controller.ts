import { Controller, Get, Post, Put, Delete, Patch, Body, Param, UseGuards } from '@nestjs/common';
import { MerchantsService } from './merchants.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard'; // Assuming this exists or will be added

@Controller('merchants')
@UseGuards(JwtAuthGuard)
export class MerchantsController {
  constructor(private readonly merchantsService: MerchantsService) {}

  @Post()
  @Roles('merchant', 'admin') // Depending on who can create
  createMerchant(@Body() data: any) {
    return this.merchantsService.createMerchant(data);
  }

  @Patch(':id/status')
  @Roles('admin') // Admin only
  updateMerchantStatus(@Param('id') id: string, @Body('is_open') isOpen: boolean) {
    return this.merchantsService.updateMerchantStatus(id, isOpen);
  }

  @Post(':id/menu-items')
  @Roles('merchant', 'admin')
  addMenuItem(@Param('id') id: string, @Body() data: any) {
    return this.merchantsService.addMenuItem(id, data);
  }

  @Get(':id/menu-items')
  getMenuItems(@Param('id') id: string) {
    return this.merchantsService.getMenuItems(id);
  }

  @Put(':id/menu-items/:itemId')
  @Roles('merchant', 'admin')
  updateMenuItem(@Param('id') id: string, @Param('itemId') itemId: string, @Body() data: any) {
    return this.merchantsService.updateMenuItem(id, itemId, data);
  }

  @Patch(':id/menu-items/:itemId/stock')
  @Roles('merchant', 'admin')
  toggleStock(@Param('id') id: string, @Param('itemId') itemId: string, @Body('in_stock') inStock: boolean) {
    return this.merchantsService.toggleStock(id, itemId, inStock);
  }

  @Delete(':id/menu-items/:itemId')
  @Roles('merchant', 'admin')
  deleteMenuItem(@Param('id') id: string, @Param('itemId') itemId: string) {
    return this.merchantsService.deleteMenuItem(id, itemId);
  }
}
