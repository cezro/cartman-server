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
  };
  let prisma: {
    verifications: {
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    tx = {
      verifications: { findUnique: jest.fn(), update: jest.fn() },
      riders: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma = {
      verifications: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
      },
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
        items: [{ id: 'v1' }],
        total: 1,
        limit: 20,
        offset: 0,
      });
    });
  });

  describe('approve', () => {
    it('sets Approved and flags the rider verified when a riders row exists', async () => {
      tx.verifications.findUnique.mockResolvedValue({
        id: 'v1',
        user_id: 'u1',
      });
      tx.verifications.update.mockResolvedValue({
        id: 'v1',
        status: 'Approved',
      });
      tx.riders.updateMany.mockResolvedValue({ count: 1 });

      const res = await service.approve('v1');

      expect(tx.verifications.update).toHaveBeenCalledWith({
        where: { id: 'v1' },
        data: { status: 'Approved' },
      });
      expect(tx.riders.updateMany).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { is_verified: true },
      });
      expect(res).toEqual({ id: 'v1', status: 'Approved' });
    });

    it('404s when the verification is missing', async () => {
      tx.verifications.findUnique.mockResolvedValue(null);

      await expect(service.approve('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('reject', () => {
    it('sets Rejected and returns the row', async () => {
      prisma.verifications.updateMany.mockResolvedValue({ count: 1 });
      prisma.verifications.findUnique.mockResolvedValue({
        id: 'v1',
        status: 'Rejected',
      });

      const res = await service.reject('v1');

      expect(res).toEqual({ id: 'v1', status: 'Rejected' });
    });

    it('404s when missing', async () => {
      prisma.verifications.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.reject('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
