import { NotFoundException } from '@nestjs/common';
import { AdminVerificationsService } from './admin-verifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminVerificationsQueryDto } from './dto/admin.dto';

function query(
  overrides: Partial<AdminVerificationsQueryDto>,
): AdminVerificationsQueryDto {
  return Object.assign(new AdminVerificationsQueryDto(), {
    limit: 20,
    offset: 0,
    ...overrides,
  });
}

describe('AdminVerificationsService', () => {
  let service: AdminVerificationsService;
  let tx: {
    verifications: { findUnique: jest.Mock; update: jest.Mock };
    riders: { updateMany: jest.Mock };
    verification_events: { create: jest.Mock };
  };
  let prisma: {
    verifications: {
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
    };
    profiles: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    tx = {
      verifications: { findUnique: jest.fn(), update: jest.fn() },
      riders: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      verification_events: { create: jest.fn().mockResolvedValue({}) },
    };
    prisma = {
      verifications: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
      },
      profiles: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    service = new AdminVerificationsService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('filters by status and orders submitted_at desc', async () => {
      prisma.verifications.findMany.mockResolvedValue([{ id: 'v1' }]);
      prisma.verifications.count.mockResolvedValue(1);

      const res = await service.list(query({ status: 'Pending' }));

      const call = (
        prisma.verifications.findMany.mock.calls as unknown[][]
      )[0][0] as {
        where: Record<string, unknown>;
        orderBy: Record<string, string>;
      };
      expect(call.where).toEqual({ status: 'Pending' });
      expect(call.orderBy).toEqual({ submitted_at: 'desc' });
      expect(res).toEqual({
        items: [
          {
            id: 'v1',
            user_name: null,
            user_role: null,
            user_phone: null,
            user_deleted: false,
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      });
    });

    it('filters by user_id, so a rider detail page need not over-fetch', async () => {
      prisma.verifications.findMany.mockResolvedValue([]);
      prisma.verifications.count.mockResolvedValue(0);

      await service.list(query({ user_id: 'u-1' }));

      const call = (
        prisma.verifications.findMany.mock.calls as unknown[][]
      )[0][0] as { where: Record<string, unknown> };
      expect(call.where).toEqual({ user_id: 'u-1' });
    });

    it('names the subject, so an admin is not approving "Unknown User"', async () => {
      // verifications has no FK to profiles and therefore no relation to
      // include; without this second lookup every row reached the dashboard
      // nameless and its fallback chain rendered the whole queue as
      // "Unknown User".
      prisma.verifications.findMany.mockResolvedValue([
        { id: 'v1', user_id: 'u-1' },
        { id: 'v2', user_id: 'u-2' },
      ]);
      prisma.verifications.count.mockResolvedValue(2);
      prisma.profiles.findMany.mockResolvedValue([
        {
          id: 'u-1',
          full_name: 'Juan Dela Cruz',
          role: 'rider',
          phone: '+639171234567',
          deleted_at: null,
        },
        {
          id: 'u-2',
          full_name: 'Closed Account',
          role: 'rider',
          phone: null,
          deleted_at: new Date(),
        },
      ]);

      const res = await service.list(query({}));

      expect(res.items[0]).toMatchObject({
        user_name: 'Juan Dela Cruz',
        user_role: 'rider',
        user_phone: '+639171234567',
        user_deleted: false,
      });
      // A tombstoned account still in the queue is flagged rather than hidden:
      // approving one would verify a closed account.
      expect(res.items[1]).toMatchObject({ user_deleted: true });
      // One lookup for the page, not one per row.
      expect(prisma.profiles.findMany).toHaveBeenCalledTimes(1);
    });

    it('skips the profile lookup entirely on an empty page', async () => {
      prisma.verifications.findMany.mockResolvedValue([]);
      prisma.verifications.count.mockResolvedValue(0);

      await service.list(query({}));

      expect(prisma.profiles.findMany).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    // Riders moved to admin_set_rider_verified, which stamps the flag, the
    // document and the audit row in one place. This service must not also do
    // it: two writers to is_verified is the split-brain this change removes.
    it('approves the row without touching riders or the audit trail', async () => {
      tx.verifications.findUnique.mockResolvedValue({
        id: 'v1',
        user_id: 'u1',
        status: 'Pending',
      });
      tx.verifications.update.mockResolvedValue({
        id: 'v1',
        status: 'Approved',
      });

      const result = await service.approve('v1', 'admin1');

      expect(tx.verifications.update).toHaveBeenCalledWith({
        where: { id: 'v1' },
        data: { status: 'Approved' },
      });
      expect(tx.riders.updateMany).not.toHaveBeenCalled();
      expect(tx.verification_events.create).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'v1', status: 'Approved' });
    });

    it('404s when the verification is missing', async () => {
      tx.verifications.findUnique.mockResolvedValue(null);

      await expect(
        service.approve('missing', 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reject', () => {
    it('rejects the row without touching riders or the audit trail', async () => {
      tx.verifications.findUnique.mockResolvedValue({
        id: 'v1',
        user_id: 'u1',
        status: 'Pending',
      });
      tx.verifications.update.mockResolvedValue({
        id: 'v1',
        status: 'Rejected',
      });

      const result = await service.reject('v1', 'admin1');

      expect(tx.verifications.update).toHaveBeenCalledWith({
        where: { id: 'v1' },
        data: { status: 'Rejected' },
      });
      expect(tx.riders.updateMany).not.toHaveBeenCalled();
      expect(tx.verification_events.create).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'v1', status: 'Rejected' });
    });

    it('404s when missing', async () => {
      tx.verifications.findUnique.mockResolvedValue(null);

      await expect(service.reject('missing', 'admin-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
