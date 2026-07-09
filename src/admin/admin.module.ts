import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminIncidentsService } from './admin-incidents.service';
import { AdminConfigService } from './admin-config.service';
import { AdminUsersService } from './admin-users.service';
import { AdminController } from './admin.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { SupabaseAdminService } from '../common/supabase-admin.service';

@Module({
  imports: [PrismaModule, LedgerModule],
  controllers: [AdminController],
  providers: [
    AdminService,
    AdminIncidentsService,
    AdminConfigService,
    AdminUsersService,
    SupabaseAdminService,
  ],
})
export class AdminModule {}
