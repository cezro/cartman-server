import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SupabaseAdminService } from '../common/supabase-admin.service';
import { AccountSweepService } from './account-sweep.service';

/**
 * L5 — the account-deletion sweep. No controller: nothing about this is
 * client-triggerable, and the only caller is the scheduler.
 */
@Module({
  imports: [PrismaModule],
  providers: [AccountSweepService, SupabaseAdminService],
  exports: [AccountSweepService],
})
export class AccountsModule {}
