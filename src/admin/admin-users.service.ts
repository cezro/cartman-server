import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { wallet_txn_type } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseAdminService } from '../common/supabase-admin.service';
import { CREDIT_TYPES } from '../ledger/ledger.service';
import { WALLET_LOCK_FLOOR } from '../orders/orders.service';
import { AdminUsersQueryDto } from './dto/admin.dto';

/**
 * Admin Dashboard V2 — cross-platform user list + manual auth interventions.
 * Auth overrides (bypass-auth, reset-2fa) are REAL: they call the Supabase
 * service-role admin API via SupabaseAdminService.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  async list(query: AdminUsersQueryDto) {
    const { limit, offset, role } = query;
    const where: Record<string, unknown> = {};
    if (role) where.role = role;

    const [profiles, total] = await Promise.all([
      this.prisma.profiles.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        skip: offset,
        include: {
          rider: { select: { is_active: true, is_verified: true } },
        },
      }),
      this.prisma.profiles.count({ where }),
    ]);

    // Net cash (for wallet_locked) folded from ONE groupBy over the riders on
    // this page — never one query per rider. Same sign-rule fold as
    // AdminService.getRiders.
    const riderIds = profiles
      .filter((p: { rider: unknown }) => p.rider)
      .map((p: { id: string }) => p.id);

    const netByRider = new Map<string, bigint>();
    if (riderIds.length > 0) {
      const rows = await this.prisma.rider_wallet_transactions.groupBy({
        by: ['rider_id', 'type'],
        where: { rider_id: { in: riderIds } },
        _sum: { amount: true },
      });
      for (const row of rows as {
        rider_id: string;
        type: wallet_txn_type;
        _sum: { amount: bigint | null };
      }[]) {
        const amount = row._sum.amount ?? 0n;
        const signed = CREDIT_TYPES.includes(row.type) ? amount : -amount;
        netByRider.set(
          row.rider_id,
          (netByRider.get(row.rider_id) ?? 0n) + signed,
        );
      }
    }

    const items = profiles.map(
      (p: {
        id: string;
        full_name: string;
        phone: string | null;
        role: string;
        suspended: boolean;
        phone_verified: boolean;
        rider: { is_active: boolean; is_verified: boolean } | null;
      }) => {
        const base = {
          id: p.id,
          full_name: p.full_name,
          phone: p.phone,
          role: p.role,
          suspended: p.suspended,
          phone_verified: p.phone_verified,
        };
        if (!p.rider) return base;
        const net = netByRider.get(p.id) ?? 0n;
        return {
          ...base,
          is_active: p.rider.is_active,
          is_verified: p.rider.is_verified,
          // Raw net cash is intentionally NOT returned — only the derived flag.
          wallet_locked: net <= WALLET_LOCK_FLOOR,
        };
      },
    );

    return { items, total, limit, offset };
  }

  async bypassAuth(id: string) {
    const { error } = await this.supabaseAdmin.updateUserById(id, {
      ban_duration: 'none',
    });
    if (error) throw this.mapSupabaseError(error.message);

    // Also clear our own ban flag so the two stay consistent.
    await this.prisma.profiles.updateMany({
      where: { id },
      data: { suspended: false },
    });

    return { message: 'Authentication block removed' };
  }

  async reset2fa(id: string) {
    const { data, error } = await this.supabaseAdmin.getUserById(id);
    if (error || !data.user) {
      throw this.mapSupabaseError(error?.message ?? 'User not found');
    }
    const email = data.user.email;
    if (!email) {
      throw new BadRequestException('User has no email to send a reset link to');
    }

    const link = await this.supabaseAdmin.generateLink({
      type: 'recovery',
      email,
    });
    if (link.error || !link.data.properties) {
      throw new BadRequestException(
        link.error?.message ?? 'Failed to generate recovery link',
      );
    }

    // Email delivery is held pending Brevo — the action link is returned so
    // the admin can relay it to the user out-of-band.
    return {
      message: 'Password/2FA reset link generated',
      action_link: link.data.properties.action_link,
    };
  }

  async toggleStatus(id: string) {
    const profile = await this.prisma.profiles.findUnique({ where: { id } });
    if (!profile) throw new NotFoundException('User not found');

    const updated = await this.prisma.profiles.update({
      where: { id },
      data: { suspended: !profile.suspended },
    });
    return { id: updated.id, suspended: updated.suspended };
  }

  // A "not found" from the Supabase admin API becomes 404; anything else is a
  // 400 (the caller sent a valid-looking id but the operation failed).
  private mapSupabaseError(message: string) {
    if (/not found/i.test(message)) {
      return new NotFoundException('User not found');
    }
    return new BadRequestException(message);
  }
}
