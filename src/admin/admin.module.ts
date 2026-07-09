import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminIncidentsService } from './admin-incidents.service';
import { AdminController } from './admin.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [PrismaModule, LedgerModule],
  controllers: [AdminController],
  providers: [AdminService, AdminIncidentsService],
})
export class AdminModule {}
