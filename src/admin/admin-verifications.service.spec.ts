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

      const res = await service.approve('v1', 'admin-1');

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

    it('records who approved whom, in the same transaction', async () => {
      tx.verifications.findUnique.mockResolvedValue({
        id: 'v1',
        user_id: 'u1',
      });
      tx.verifications.update.mockResolvedValue({ id: 'v1' });
      tx.riders.updateMany.mockResolvedValue({ count: 1 });

      await service.approve('v1', 'admin-1');

      // Without this the gate has no audit trail at all: 5 riders were
      // verified on CartmanPH and verification_events held 0 rows, because
      // this path writes is_verified directly instead of going through
      // admin_set_rider_verified (which cannot be called from here — it reads
      // auth.uid(), which is null on a Prisma connection).
      expect(tx.verification_events.create).toHaveBeenCalledWith({
        data: {
          subject_kind: 'rider',
          subject_id: 'u1',
          approved: true,
          actor_id: 'admin-1',
        },
      });
    });

    it('does not record a rider event when no rider row matched', async () => {
      tx.verifications.findUnique.mockResolvedValue({
        id: 'v1',
        user_id: 'u1',
      });
      tx.verifications.update.mockResolvedValue({ id: 'v1' });
      tx.riders.updateMany.mockResolvedValue({ count: 0 });

      await service.approve('v1', 'admin-1');

      // `verifications` also carries merchant business permits, where the
      // rider updateMany is a deliberate no-op. Logging 'rider' there would
      // put a row in the audit trail describing something that never happened.
      expect(tx.verification_events.create).not.toHaveBeenCalled();
    });

    it('404s when the verification is missing', async () => {
      tx.verifications.findUnique.mockResolvedValue(null);

      await expect(
        service.approve('missing', 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reject', () => {
    it('sets Rejected and returns the row', async () => {
      tx.verifications.findUnique.mockResolvedValue({
        id: 'v1',
        user_id: 'u-1',
      });
      tx.verifications.update.mockResolvedValue({
        id: 'v1',
        status: 'Rejected',
      });

      const res = await service.reject('v1', 'admin-1');

      expect(res).toEqual({ id: 'v1', status: 'Rejected' });
    });

    it('revokes an existing approval', async () => {
      // Without this, rejecting a rider approved on an earlier submission
      // recorded the decision and left the access it controls untouched — the
      // rider kept taking COD orders on a document just refused.
      tx.verifications.findUnique.mockResolvedValue({
        id: 'v1',
        user_id: 'u-1',
      });
      tx.verifications.update.mockResolvedValue({ id: 'v1' });
      tx.riders.updateMany.mockResolvedValue({ count: 1 });

      await service.reject('v1', 'admin-1');

      expect(tx.riders.updateMany).toHaveBeenCalledWith({
        where: { id: 'u-1' },
        data: { is_verified: false },
      });
    });

    it('writes the audit row, naming the admin who refused', async () => {
      tx.verifications.findUnique.mockResolvedValue({
        id: 'v1',
        user_id: 'u-1',
      });
      tx.verifications.update.mockResolvedValue({ id: 'v1' });
      tx.riders.updateMany.mockResolvedValue({ count: 1 });

      await service.reject('v1', 'admin-1');

      expect(tx.verification_events.create).toHaveBeenCalledWith({
        data: {
          subject_kind: 'rider',
          subject_id: 'u-1',
          approved: false,
          actor_id: 'admin-1',
        },
      });
    });

    it('logs no rider event for a merchant permit', async () => {
      // Same rule as approve: `verifications` also carries business permits,
      // where the riders updateMany is a deliberate no-op and a 'rider' audit
      // row would describe something that never happened.
      tx.verifications.findUnique.mockResolvedValue({
        id: 'v1',
        user_id: 'merchant-owner',
      });
      tx.verifications.update.mockResolvedValue({ id: 'v1' });
      tx.riders.updateMany.mockResolvedValue({ count: 0 });

      await service.reject('v1', 'admin-1');

      expect(tx.verification_events.create).not.toHaveBeenCalled();
    });

    it('404s when missing', async () => {
      tx.verifications.findUnique.mockResolvedValue(null);

      await expect(service.reject('missing', 'admin-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
