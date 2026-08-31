import { ConflictException } from '@nestjs/common';
import { RidersService } from './riders.service';
import { PrismaService } from '../prisma/prisma.service';

// Google sign-in can't carry `role: 'rider'` through OAuth, so handle_new_user
// provisions every Google account as a plain 'customer' with no `riders` row —
// which the rider app's router guard then refuses. This endpoint is the only
// path that can promote such an account, so it deliberately does NOT sit behind
// @Roles('rider') (that would be unreachable by definition). See
// apps/rider/lib/src/router.dart's guard in the mobile repo.
describe('RidersService.onboardRider', () => {
  let service: RidersService;
  let tx: {
    riders: { create: jest.Mock };
    profiles: { update: jest.Mock };
    verifications: { create: jest.Mock };
  };
  let prisma: {
    riders: { findUnique: jest.Mock };
    verifications: { findFirst: jest.Mock; create: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    tx = {
      riders: { create: jest.fn() },
      profiles: { update: jest.fn() },
      verifications: { create: jest.fn() },
    };
    prisma = {
      riders: { findUnique: jest.fn() },
      verifications: { findFirst: jest.fn(), create: jest.fn() },
      $transaction: jest.fn(
        (cb: (t: typeof tx) => unknown) => cb(tx) as unknown,
      ),
    };
    service = new RidersService(prisma as unknown as PrismaService);
  });

  it('promotes the profile to rider and creates the riders row', async () => {
    prisma.riders.findUnique.mockResolvedValue(null);
    tx.riders.create.mockResolvedValue({ id: 'u-1', vehicle: 'Motorcycle' });

    await service.onboardRider('u-1', {
      vehicle: 'Motorcycle',
      plate_no: 'ABC 1234',
      phone: '+639171234567',
    });

    expect(tx.riders.create).toHaveBeenCalledWith({
      data: { id: 'u-1', vehicle: 'Motorcycle', plate_no: 'ABC 1234' },
    });
    expect(tx.profiles.update).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      data: { role: 'rider', phone: '+639171234567' },
    });
  });

  it('leaves is_verified alone so admin approval is still required', async () => {
    prisma.riders.findUnique.mockResolvedValue(null);
    tx.riders.create.mockResolvedValue({ id: 'u-1' });

    await service.onboardRider('u-1', { vehicle: 'Bicycle' });

    const createArg = tx.riders.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data).not.toHaveProperty('is_verified');
    expect(createArg.data).not.toHaveProperty('is_active');
  });

  // The deep link can re-deliver, and a rider who backgrounds the app mid-flow
  // can land here twice — a second call must not 500 on the PK collision.
  it('is idempotent: returns the existing row without re-promoting', async () => {
    prisma.riders.findUnique.mockResolvedValue({ id: 'u-1', vehicle: 'Car' });

    const result = await service.onboardRider('u-1', { vehicle: 'Motorcycle' });

    expect(result).toEqual({ id: 'u-1', vehicle: 'Car' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.profiles.update).not.toHaveBeenCalled();
  });

  it('omits phone from the profile update when none was supplied', async () => {
    prisma.riders.findUnique.mockResolvedValue(null);
    tx.riders.create.mockResolvedValue({ id: 'u-1' });

    await service.onboardRider('u-1', { vehicle: 'Motorcycle' });

    expect(tx.profiles.update).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      data: { role: 'rider' },
    });
  });

  // profiles.phone is UNIQUE — a number already claimed by another account
  // must read as a conflict, not an opaque 500.
  it('maps a duplicate phone to a 409 instead of leaking a Prisma error', async () => {
    prisma.riders.findUnique.mockResolvedValue(null);
    tx.riders.create.mockResolvedValue({ id: 'u-1' });
    tx.profiles.update.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );

    await expect(
      service.onboardRider('u-1', {
        vehicle: 'Motorcycle',
        phone: '+639171234567',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('RidersService.getDeliveryHistory', () => {
  let service: RidersService;
  let prisma: {
    orders: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      orders: { findMany: jest.fn() },
    };
    service = new RidersService(prisma as unknown as PrismaService);
  });

  it('includes order_items and order_stops so rowToOrder can map a full Order', async () => {
    prisma.orders.findMany.mockResolvedValue([]);

    await service.getDeliveryHistory('rider-1');

    expect(prisma.orders.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          assigned_rider_id: 'rider-1',
          status: 'delivered',
        },
        include: expect.objectContaining({
          order_items: true,
          order_stops: true,
        }) as Record<string, unknown>,
      }) as Record<string, unknown>,
    );
  });

  it('serializes bigint money fields to numbers (delivery_payout, total, etc)', async () => {
    prisma.orders.findMany.mockResolvedValue([
      {
        id: 'order-1',
        subtotal: 10000n,
        delivery_fee: 4900n,
        discount: 0n,
        total: 14900n,
        delivery_payout: 5000n,
        order_items: [{ id: 1n, unit_price: 15000n }],
        order_stops: [],
      },
    ]);

    const result = await service.getDeliveryHistory('rider-1');

    expect(result[0].delivery_payout).toBe(5000);
    expect(result[0].total).toBe(14900);
    expect(typeof result[0].delivery_payout).toBe('number');
    expect(result[0].order_items[0].unit_price).toBe(15000);
  });
});

// Rider verification moved to rider_documents + admin_set_rider_verified
// (see cartmanph-docs/docs/proposals/rider-verification-source-of-truth.md).
// A rider's review is now the document they upload, not a placeholder row —
// so provisioning a rider must NOT touch `verifications` at all. These tests
// are the inverse of the ones they replace.
describe('RidersService — provisioning writes no verifications row', () => {
  let prisma: {
    riders: { findUnique: jest.Mock; create: jest.Mock };
    profiles: { update: jest.Mock };
    verifications: { create: jest.Mock; findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: {
    riders: { create: jest.Mock };
    profiles: { update: jest.Mock };
    verifications: { create: jest.Mock };
  };
  let service: RidersService;

  beforeEach(() => {
    tx = {
      riders: { create: jest.fn().mockResolvedValue({ id: 'r1' }) },
      profiles: { update: jest.fn() },
      verifications: { create: jest.fn() },
    };
    prisma = {
      riders: { findUnique: jest.fn(), create: jest.fn() },
      profiles: { update: jest.fn() },
      verifications: { create: jest.fn(), findFirst: jest.fn() },
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    };
    service = new RidersService(prisma as unknown as PrismaService);
  });

  it('opens no review when a rider self-onboards', async () => {
    prisma.riders.findUnique.mockResolvedValue(null);
    await service.onboardRider('r1', { vehicle: 'motorcycle' });
    expect(tx.verifications.create).not.toHaveBeenCalled();
    expect(prisma.verifications.create).not.toHaveBeenCalled();
  });

  it('opens no review on the ops-created rider route either', async () => {
    await service.createRider('r1', { vehicle: 'motorcycle' });
    expect(tx.verifications.create).not.toHaveBeenCalled();
  });

  it('does not self-heal an existing unverified rider into the old queue', async () => {
    prisma.riders.findUnique.mockResolvedValue({
      id: 'r1',
      is_verified: false,
    });
    await service.onboardRider('r1', {});
    expect(prisma.verifications.findFirst).not.toHaveBeenCalled();
    expect(prisma.verifications.create).not.toHaveBeenCalled();
  });

  it('still leaves is_verified alone, so admin approval is required', async () => {
    prisma.riders.findUnique.mockResolvedValue(null);
    await service.onboardRider('r1', { vehicle: 'motorcycle' });
    const created = tx.riders.create.mock.calls[0][0] as {
      data: { is_verified?: boolean };
    };
    expect(created.data.is_verified).toBeUndefined();
  });
});
