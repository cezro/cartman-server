import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminUsersService } from './admin-users.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseAdminService } from '../common/supabase-admin.service';
import { AdminUsersQueryDto } from './dto/admin.dto';

function query(overrides: Partial<AdminUsersQueryDto>): AdminUsersQueryDto {
  return Object.assign(new AdminUsersQueryDto(), {
    limit: 20,
    offset: 0,
    ...overrides,
  });
}

describe('AdminUsersService', () => {
  let service: AdminUsersService;
  let prisma: {
    profiles: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
    rider_wallet_transactions: { groupBy: jest.Mock };
  };
  let supabase: {
    updateUserById: jest.Mock;
    getUserById: jest.Mock;
    generateLink: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      profiles: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      rider_wallet_transactions: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    supabase = {
      updateUserById: jest.fn(),
      getUserById: jest.fn(),
      generateLink: jest.fn(),
    };
    service = new AdminUsersService(
      prisma as unknown as PrismaService,
      supabase as unknown as SupabaseAdminService,
    );
  });

  describe('list', () => {
    it('filters by role and emits rider fields only when a riders row exists', async () => {
      prisma.profiles.findMany.mockResolvedValue([
        {
          id: 'c1',
          full_name: 'Cust',
          phone: '1',
          role: 'customer',
          suspended: false,
          phone_verified: true,
          rider: null,
        },
        {
          id: 'r1',
          full_name: 'Rider',
          phone: '2',
          role: 'rider',
          suspended: false,
          phone_verified: true,
          rider: { is_active: true, is_verified: false },
        },
      ]);
      prisma.profiles.count.mockResolvedValue(2);
      prisma.rider_wallet_transactions.groupBy.mockResolvedValue([
        { rider_id: 'r1', type: 'debit_cod_order', _sum: { amount: 300000n } },
      ]);

      const res = await service.list(query({ role: 'rider' }));

      expect(prisma.profiles.findMany.mock.calls[0][0].where).toEqual({
        role: 'rider',
      });
      const customer = res.items[0] as Record<string, unknown>;
      const rider = res.items[1] as Record<string, unknown>;
      expect(customer).not.toHaveProperty('is_active');
      expect(customer).not.toHaveProperty('wallet_locked');
      // rider owes ₱3,000 (net −300000 ≤ −200000 floor) → locked
      expect(rider.is_active).toBe(true);
      expect(rider.is_verified).toBe(false);
      expect(rider.wallet_locked).toBe(true);
      // no raw money field leaks
      expect(rider).not.toHaveProperty('net_cash');
    });

    it('batches net-cash in one groupBy (no per-rider query)', async () => {
      prisma.profiles.findMany.mockResolvedValue([
        { id: 'r1', role: 'rider', rider: { is_active: true, is_verified: true } },
        { id: 'r2', role: 'rider', rider: { is_active: false, is_verified: true } },
      ]);
      prisma.profiles.count.mockResolvedValue(2);

      await service.list(query({}));

      expect(prisma.rider_wallet_transactions.groupBy).toHaveBeenCalledTimes(1);
    });
  });

  describe('bypassAuth', () => {
    it('lifts the ban and clears suspended', async () => {
      supabase.updateUserById.mockResolvedValue({
        data: { user: { id: 'u1' } },
        error: null,
      });

      const res = await service.bypassAuth('u1');

      expect(supabase.updateUserById).toHaveBeenCalledWith('u1', {
        ban_duration: 'none',
      });
      expect(prisma.profiles.updateMany).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { suspended: false },
      });
      expect(res).toHaveProperty('message');
    });

    it('maps a Supabase error to 400', async () => {
      supabase.updateUserById.mockResolvedValue({
        data: { user: null },
        error: { message: 'boom' },
      });

      await expect(service.bypassAuth('u1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('reset2fa', () => {
    it('returns the recovery action_link', async () => {
      supabase.getUserById.mockResolvedValue({
        data: { user: { id: 'u1', email: 'a@b.co' } },
        error: null,
      });
      supabase.generateLink.mockResolvedValue({
        data: { properties: { action_link: 'https://recover.link/xyz' } },
        error: null,
      });

      const res = await service.reset2fa('u1');

      expect(supabase.generateLink).toHaveBeenCalledWith({
        type: 'recovery',
        email: 'a@b.co',
      });
      expect(res.action_link).toBe('https://recover.link/xyz');
      expect(res).toHaveProperty('message');
    });

    it('400s when the user has no email', async () => {
      supabase.getUserById.mockResolvedValue({
        data: { user: { id: 'u1', email: null } },
        error: null,
      });

      await expect(service.reset2fa('u1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('404s when the user does not exist', async () => {
      supabase.getUserById.mockResolvedValue({
        data: { user: null },
        error: { message: 'User not found' },
      });

      await expect(service.reset2fa('u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('toggleStatus', () => {
    it('flips suspended and returns the new value', async () => {
      prisma.profiles.findUnique.mockResolvedValue({
        id: 'u1',
        suspended: false,
      });
      prisma.profiles.update.mockResolvedValue({ id: 'u1', suspended: true });

      const res = await service.toggleStatus('u1');

      expect(prisma.profiles.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { suspended: true },
      });
      expect(res).toEqual({ id: 'u1', suspended: true });
    });

    it('404s when no profile', async () => {
      prisma.profiles.findUnique.mockResolvedValue(null);

      await expect(service.toggleStatus('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
