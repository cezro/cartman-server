import { AccountSweepService } from './account-sweep.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseAdminService } from '../common/supabase-admin.service';

/**
 * L5. The failure mode this guards is a sweep that reports success while the
 * credentials still work — the same "fails upward" shape as the POD write that
 * matched zero rows.
 */
describe('AccountSweepService', () => {
  let prisma: {
    profiles: { findMany: jest.Mock; update: jest.Mock };
  };
  let supabaseAdmin: { deleteUser: jest.Mock };
  let service: AccountSweepService;

  beforeEach(() => {
    prisma = {
      profiles: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    supabaseAdmin = {
      deleteUser: jest.fn().mockResolvedValue({ error: null }),
    };

    service = new AccountSweepService(
      prisma as unknown as PrismaService,
      supabaseAdmin as unknown as SupabaseAdminService,
    );
  });

  it('only looks at tombstones that have not been swept yet', async () => {
    await service.sweep();

    // Both halves matter: without `deleted_at not null` it would delete live
    // accounts; without `auth_deleted_at: null` it re-sweeps every account
    // ever deleted, forever, because profiles has no FK to auth.users.
    expect(prisma.profiles.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deleted_at: { not: null }, auth_deleted_at: null },
      }),
    );
  });

  it('deletes the auth user and stamps the profile', async () => {
    prisma.profiles.findMany.mockResolvedValue([{ id: 'u-1' }]);

    const result = await service.sweep();

    expect(supabaseAdmin.deleteUser).toHaveBeenCalledWith('u-1');
    expect(prisma.profiles.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u-1' },
        data: { auth_deleted_at: expect.any(Date) as Date },
      }),
    );
    expect(result).toEqual({ swept: 1, failed: 0 });
  });

  it('does NOT stamp a profile whose auth user could not be deleted', async () => {
    prisma.profiles.findMany.mockResolvedValue([{ id: 'u-1' }]);
    supabaseAdmin.deleteUser.mockResolvedValue({
      error: { message: 'upstream exploded', status: 500 },
    });

    const result = await service.sweep();

    // Stamping here would mark an account done while its credentials still
    // work, and nothing would ever look at it again.
    expect(prisma.profiles.update).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 0, failed: 1 });
  });

  it('treats an already-absent auth user as swept, not as a failure', async () => {
    prisma.profiles.findMany.mockResolvedValue([{ id: 'u-1' }]);
    supabaseAdmin.deleteUser.mockResolvedValue({
      error: { message: 'User not found', status: 404 },
    });

    const result = await service.sweep();

    // Otherwise a row deleted out of band, or one whose stamp did not land,
    // is retried every hour for the life of the deployment.
    expect(prisma.profiles.update).toHaveBeenCalled();
    expect(result).toEqual({ swept: 1, failed: 0 });
  });

  it('one failure does not stop the rest of the batch', async () => {
    prisma.profiles.findMany.mockResolvedValue([
      { id: 'u-1' },
      { id: 'u-2' },
      { id: 'u-3' },
    ]);
    supabaseAdmin.deleteUser
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: { message: 'boom', status: 500 } })
      .mockResolvedValueOnce({ error: null });

    const result = await service.sweep();

    expect(result).toEqual({ swept: 2, failed: 1 });
    expect(supabaseAdmin.deleteUser).toHaveBeenCalledTimes(3);
  });

  it('does nothing, and calls nothing, when there is nothing to sweep', async () => {
    const result = await service.sweep();

    expect(supabaseAdmin.deleteUser).not.toHaveBeenCalled();
    expect(prisma.profiles.update).not.toHaveBeenCalled();
    expect(result).toEqual({ swept: 0, failed: 0 });
  });

  it('the scheduled entry point swallows errors rather than killing the process', async () => {
    prisma.profiles.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.handleCron()).resolves.toBeUndefined();
  });
});
