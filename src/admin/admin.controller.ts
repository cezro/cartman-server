import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminConfigService } from './admin-config.service';
import { AdminUsersService } from './admin-users.service';
import { AdminVerificationsService } from './admin-verifications.service';
import { AdminTicketsService } from './admin-tickets.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';
import {
  AdminOrdersQueryDto,
  ReassignOrderDto,
  AdminRidersQueryDto,
  AdminMerchantsQueryDto,
  AdminLedgerQueryDto,
  UpdateConfigDto,
  AdminUsersQueryDto,
  AdminVerificationsQueryDto,
  AdminTicketsQueryDto,
  UpdateTicketStatusDto,
} from './dto/admin.dto';

// Single admin surface for the Next.js admin dashboard prototype. Every
// route here is admin-only — enforced once at class level (RolesGuard reads
// @Roles() via getAllAndOverride([handler, class]), so a class-level
// decorator applies to every method that doesn't override it).
@Controller('admin')
@UseGuards(JwtAuthGuard)
@Roles('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly configService: AdminConfigService,
    private readonly usersService: AdminUsersService,
    private readonly verificationsService: AdminVerificationsService,
    private readonly ticketsService: AdminTicketsService,
  ) {}

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

  @Get('riders')
  getRiders(@Query() query: AdminRidersQueryDto) {
    return this.adminService.getRiders(query);
  }

  @Get('merchants')
  getMerchants(@Query() query: AdminMerchantsQueryDto) {
    return this.adminService.getMerchants(query);
  }

  @Get('ledger/transactions')
  getLedgerTransactions(@Query() query: AdminLedgerQueryDto) {
    return this.adminService.getLedgerTransactions(query);
  }

  // ══ Admin Dashboard V2 — global config (singleton) ══════════════════════

  @Get('config')
  getConfig() {
    return this.configService.get();
  }

  @Post('config')
  updateConfig(@Body() body: UpdateConfigDto) {
    return this.configService.update(body);
  }

  // ══ Admin Dashboard V2 — users + auth overrides ═════════════════════════

  @Get('users')
  getUsers(@Query() query: AdminUsersQueryDto) {
    return this.usersService.list(query);
  }

  @Post('users/:id/bypass-auth')
  bypassAuth(@Param('id') id: string) {
    return this.usersService.bypassAuth(id);
  }

  @Post('users/:id/reset-2fa')
  reset2fa(@Param('id') id: string) {
    return this.usersService.reset2fa(id);
  }

  @Post('users/:id/toggle-status')
  toggleStatus(@Param('id') id: string) {
    return this.usersService.toggleStatus(id);
  }

  // ══ Admin Dashboard V2 — verification pipeline ══════════════════════════

  @Get('verifications')
  getVerifications(@Query() query: AdminVerificationsQueryDto) {
    return this.verificationsService.list(query);
  }

  @Post('verifications/:id/approve')
  approveVerification(
    @Param('id') id: string,
    // Who opened the gate. Passed explicitly because the SQL RPC that would
    // normally record it (`admin_set_rider_verified`) reads `auth.uid()`,
    // which is null on this server's Prisma connection.
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.verificationsService.approve(id, user.id);
  }

  @Post('verifications/:id/reject')
  rejectVerification(
    @Param('id') id: string,
    // Same reason as approve: a rejection is a decision someone may contest,
    // and it now also revokes an existing approval.
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.verificationsService.reject(id, user.id);
  }

  // ══ Admin Dashboard V2 — support tickets ════════════════════════════════

  @Get('tickets')
  getTickets(@Query() query: AdminTicketsQueryDto) {
    return this.ticketsService.list(query);
  }

  @Patch('tickets/:id/status')
  updateTicketStatus(
    @Param('id') id: string,
    @Body() body: UpdateTicketStatusDto,
  ) {
    return this.ticketsService.updateStatus(id, body);
  }
}
