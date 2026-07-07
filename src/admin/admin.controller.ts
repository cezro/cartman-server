import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { AdminOrdersQueryDto } from './dto/admin.dto';

// Single admin surface for the Next.js admin dashboard prototype. Every
// route here is admin-only — enforced once at class level (RolesGuard reads
// @Roles() via getAllAndOverride([handler, class]), so a class-level
// decorator applies to every method that doesn't override it).
@Controller('admin')
@UseGuards(JwtAuthGuard)
@Roles('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  getStats() {
    return this.adminService.getStats();
  }

  @Get('orders')
  getOrders(@Query() query: AdminOrdersQueryDto) {
    return this.adminService.getOrders(query);
  }

  @Get('orders/:id')
  getOrderById(@Param('id') id: string) {
    return this.adminService.getOrderById(id);
  }
}
