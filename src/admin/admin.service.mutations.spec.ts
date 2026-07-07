import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WALLET_LOCK_FLOOR } from '../orders/orders.service';

describe('AdminService.cancelOrder', () => {
  let service: AdminService;
  let prisma: {
    orders: { updateMany: jest.Mock; findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      orders: { updateMany: jest.fn(), findUnique: jest.fn() },
    };
    service = new AdminService(
      prisma as unknown as PrismaService,
      {} as LedgerService,
    );
  });

  const NON_TERMINAL_STATUSES = [
    'pending',
    'preparing',
    'ready_for_pickup',
    'accepted',
    'arrived_at_merchant',
    'picked_up',
    'in_transit',
  ];

  it.each(NON_TERMINAL_STATUSES)(
    'cancels an order currently in status %s',
    async (status) => {
      prisma.orders.updateMany.mockResolvedValue({ count: 1 });
      prisma.orders.findUnique.mockResolvedValue({
        id: 'o1',
        status: 'canceled',
        total: 1000n,
        subtotal: 1000n,
        delivery_fee: 0n,
        discount: 0n,
        delivery_payout: 0n,
      });

      const result = await service.cancelOrder('o1');

      expect(result.status).toBe('canceled');
      const call = prisma.orders.updateMany.mock.calls[0][0];
      expect(call.where.id).toBe('o1');
      expect(call.where.status.notIn).toEqual(['delivered', 'canceled']);
      expect(call.data.status).toBe('canceled');
    },
  );

  it('returns 400 when the order is already delivered', async () => {
    prisma.orders.updateMany.mockResolvedValue({ count: 0 });
    prisma.orders.findUnique.mockResolvedValue({ id: 'o1', status: 'delivered' });

    await expect(service.cancelOrder('o1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns 400 when the order is already canceled', async () => {
    prisma.orders.updateMany.mockResolvedValue({ count: 0 });
    prisma.orders.findUnique.mockResolvedValue({ id: 'o1', status: 'canceled' });

    await expect(service.cancelOrder('o1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('returns 404 when the order does not exist', async () => {
    prisma.orders.updateMany.mockResolvedValue({ count: 0 });
    prisma.orders.findUnique.mockResolvedValue(null);

    await expect(service.cancelOrder('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('AdminService.reassignOrder', () => {
  let service: AdminService;
  let prisma: {
    orders: { findUnique: jest.Mock; updateMany: jest.Mock; count: jest.Mock };
    riders: { findUnique: jest.Mock };
  };
  let ledgerService: { getNetCash: jest.Mock };

  const EXISTING_ORDER = {
    id: 'o1',
    assigned_rider_id: 'old-rider',
    status: 'ready_for_pickup',
    total: 1000n,
    subtotal: 1000n,
    delivery_fee: 0n,
    discount: 0n,
    delivery_payout: 0n,
  };

  function freshOrder(overrides: Partial<typeof EXISTING_ORDER> = {}) {
    return { ...EXISTING_ORDER, ...overrides };
  }

  beforeEach(() => {
    prisma = {
      orders: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
      riders: { findUnique: jest.fn() },
    };
    ledgerService = { getNetCash: jest.fn() };
    service = new AdminService(
      prisma as unknown as PrismaService,
      ledgerService as unknown as LedgerService,
    );
  });

  it('404s when the order does not exist', async () => {
    prisma.orders.findUnique.mockResolvedValue(null);

    await expect(
      service.reassignOrder('missing', 'new-rider'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.riders.findUnique).not.toHaveBeenCalled();
  });

  it('blocks reassignment to an inactive rider', async () => {
    prisma.orders.findUnique.mockResolvedValue(freshOrder());
    prisma.riders.findUnique.mockResolvedValue({ id: 'new-rider', is_active: false });

    await expect(
      service.reassignOrder('o1', 'new-rider'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.orders.updateMany).not.toHaveBeenCalled();
  });

  it('blocks reassignment to a rider with a nonexistent riders row', async () => {
    prisma.orders.findUnique.mockResolvedValue(freshOrder());
    prisma.riders.findUnique.mockResolvedValue(null);

    await expect(
      service.reassignOrder('o1', 'new-rider'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks reassignment to a rider whose wallet is locked (net cash <= floor)', async () => {
    prisma.orders.findUnique.mockResolvedValue(freshOrder());
    prisma.riders.findUnique.mockResolvedValue({ id: 'new-rider', is_active: true });
    ledgerService.getNetCash.mockResolvedValue(WALLET_LOCK_FLOOR);

    await expect(
      service.reassignOrder('o1', 'new-rider'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.orders.updateMany).not.toHaveBeenCalled();
  });

  it('blocks reassignment to a rider with a full active order queue', async () => {
    prisma.orders.findUnique.mockResolvedValue(freshOrder());
    prisma.riders.findUnique.mockResolvedValue({ id: 'new-rider', is_active: true });
    ledgerService.getNetCash.mockResolvedValue(0n);
    prisma.orders.count.mockResolvedValue(2); // MAX_ACTIVE_ORDERS_PER_RIDER

    await expect(
      service.reassignOrder('o1', 'new-rider'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.orders.updateMany).not.toHaveBeenCalled();
  });

  it('blocks reassignment when rider_id is the order\'s current assigned rider', async () => {
    prisma.orders.findUnique.mockResolvedValue(
      freshOrder({ assigned_rider_id: 'same-rider' }),
    );
    prisma.riders.findUnique.mockResolvedValue({ id: 'same-rider', is_active: true });
    ledgerService.getNetCash.mockResolvedValue(0n);
    prisma.orders.count.mockResolvedValue(0);

    await expect(
      service.reassignOrder('o1', 'same-rider'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.orders.updateMany).not.toHaveBeenCalled();
  });

  it.each(['picked_up', 'in_transit', 'delivered', 'canceled', 'pending', 'preparing'])(
    'blocks reassignment when the order is currently in status %s (atomic race path)',
    async (status) => {
      prisma.orders.findUnique
        .mockResolvedValueOnce(freshOrder({ status })) // initial read
        .mockResolvedValueOnce(freshOrder({ status })); // post-race re-read
      prisma.riders.findUnique.mockResolvedValue({ id: 'new-rider', is_active: true });
      ledgerService.getNetCash.mockResolvedValue(0n);
      prisma.orders.count.mockResolvedValue(0);
      prisma.orders.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.reassignOrder('o1', 'new-rider'),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('404s on the count=0 race path when the order vanished between check and update', async () => {
    prisma.orders.findUnique
      .mockResolvedValueOnce(freshOrder())
      .mockResolvedValueOnce(null);
    prisma.riders.findUnique.mockResolvedValue({ id: 'new-rider', is_active: true });
    ledgerService.getNetCash.mockResolvedValue(0n);
    prisma.orders.count.mockResolvedValue(0);
    prisma.orders.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.reassignOrder('o1', 'new-rider'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reassigns successfully: sets assigned_rider_id + status accepted, returns serialized order', async () => {
    prisma.orders.findUnique
      .mockResolvedValueOnce(freshOrder({ status: 'arrived_at_merchant' }))
      .mockResolvedValueOnce(
        freshOrder({
          status: 'accepted',
          assigned_rider_id: 'new-rider',
        }),
      );
    prisma.riders.findUnique.mockResolvedValue({ id: 'new-rider', is_active: true });
    ledgerService.getNetCash.mockResolvedValue(0n);
    prisma.orders.count.mockResolvedValue(0);
    prisma.orders.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.reassignOrder('o1', 'new-rider');

    expect(result.status).toBe('accepted');
    expect(result.assigned_rider_id).toBe('new-rider');
    const updateCall = prisma.orders.updateMany.mock.calls[0][0];
    expect(updateCall.where.status.in).toEqual(
      expect.arrayContaining(['ready_for_pickup', 'accepted', 'arrived_at_merchant']),
    );
    expect(updateCall.data).toEqual({
      assigned_rider_id: 'new-rider',
      status: 'accepted',
    });
  });
});
