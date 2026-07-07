import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { AdminOrdersQueryDto, ReassignOrderDto } from './dto/admin.dto';

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

  @Patch('orders/:id/cancel')
  cancelOrder(@Param('id') id: string) {
    return this.adminService.cancelOrder(id);
  }

  @Patch('orders/:id/reassign')
  reassignOrder(@Param('id') id: string, @Body() body: ReassignOrderDto) {
    return this.adminService.reassignOrder(id, body.rider_id);
  }
}
