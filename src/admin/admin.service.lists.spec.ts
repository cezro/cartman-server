import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import {
  AdminRidersQueryDto,
  AdminMerchantsQueryDto,
  AdminLedgerQueryDto,
} from './dto/admin.dto';

function query<T>(cls: new () => T, overrides: Partial<T>): T {
  return Object.assign(new cls(), { limit: 20, offset: 0 }, overrides);
}

// Typed call shape for list findMany() mocks so mock.calls entries aren't
// `any` — mirrors the typed mock pattern in admin.service.mutations.spec.ts.
interface FindManyCall {
  where: Record<string, unknown>;
  take: number;
  skip: number;
  orderBy?: Record<string, unknown>;
}
type FindManyMock = jest.Mock<Promise<unknown[]>, [FindManyCall]>;

describe('AdminService.getRiders', () => {
  let service: AdminService;
  let prisma: {
    riders: { findMany: FindManyMock; count: jest.Mock };
    orders: { groupBy: jest.Mock };
    rider_wallet_transactions: { groupBy: jest.Mock };
    rider_locations: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      riders: {
        findMany: jest.fn<Promise<unknown[]>, [FindManyCall]>(),
        count: jest.fn(),
      },
      orders: { groupBy: jest.fn() },
      rider_wallet_transactions: { groupBy: jest.fn() },
      rider_locations: { findMany: jest.fn() },
    };
    prisma.riders.findMany.mockResolvedValue([]);
    prisma.riders.count.mockResolvedValue(0);
    prisma.orders.groupBy.mockResolvedValue([]);
    prisma.rider_wallet_transactions.groupBy.mockResolvedValue([]);
    prisma.rider_locations.findMany.mockResolvedValue([]);
    service = new AdminService(
      prisma as unknown as PrismaService,
      {} as LedgerService,
    );
  });

  it('does NOT loop per rider — exactly one call each to the three batch queries regardless of rider count', async () => {
    prisma.riders.findMany.mockResolvedValue([
      {
        id: 'r1',
        is_active: true,
        vehicle: 'Motor',
        plate_no: 'AAA',
        rating: 5,
        acceptance_rate: 1,
        total_trips: 3,
        profile: { full_name: 'A', phone: '1' },
      },
      {
        id: 'r2',
        is_active: true,
        vehicle: 'Motor',
        plate_no: 'BBB',
        rating: 5,
        acceptance_rate: 1,
        total_trips: 3,
        profile: { full_name: 'B', phone: '2' },
      },
      {
        id: 'r3',
        is_active: false,
        vehicle: 'Motor',
        plate_no: 'CCC',
        rating: 5,
        acceptance_rate: 1,
        total_trips: 3,
        profile: { full_name: 'C', phone: '3' },
      },
    ]);

    await service.getRiders(query(AdminRidersQueryDto, {}));

    expect(prisma.orders.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.rider_wallet_transactions.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.rider_locations.findMany).toHaveBeenCalledTimes(1);
  });

  it('folds active_orders, net_cash, wallet_locked, and last_location onto each rider', async () => {
    prisma.riders.findMany.mockResolvedValue([
      {
        id: 'r1',
        is_active: true,
        vehicle: 'Motor',
        plate_no: 'AAA',
        rating: 5,
        acceptance_rate: 1,
        total_trips: 3,
        profile: { full_name: 'A', phone: '1' },
      },
    ]);
    prisma.orders.groupBy.mockResolvedValue([
      { assigned_rider_id: 'r1', _count: { _all: 2 } },
    ]);
    prisma.rider_wallet_transactions.groupBy.mockResolvedValue([
      { rider_id: 'r1', type: 'debit_cod_order', _sum: { amount: 300000n } },
    ]);
    prisma.rider_locations.findMany.mockResolvedValue([
      {
        rider_id: 'r1',
        lat: 1,
        lng: 2,
        recorded_at: new Date('2026-07-05T00:00:00.000Z'),
      },
    ]);

    const result = await service.getRiders(query(AdminRidersQueryDto, {}));

    expect(result.items[0]).toMatchObject({
      id: 'r1',
      full_name: 'A',
      phone: '1',
      active_orders: 2,
      net_cash: -300000,
      wallet_locked: true,
      last_location: {
        lat: 1,
        lng: 2,
        recorded_at: new Date('2026-07-05T00:00:00.000Z'),
      },
    });
  });

  it('marks wallet_locked false when net cash is above the floor', async () => {
    prisma.riders.findMany.mockResolvedValue([
      {
        id: 'r1',
        is_active: true,
        vehicle: '',
        plate_no: '',
        rating: 5,
        acceptance_rate: 1,
        total_trips: 0,
        profile: { full_name: 'A', phone: '1' },
      },
    ]);
    prisma.rider_wallet_transactions.groupBy.mockResolvedValue([
      { rider_id: 'r1', type: 'credit_remittance', _sum: { amount: 1000n } },
    ]);

    const result = await service.getRiders(query(AdminRidersQueryDto, {}));

    expect(result.items[0].wallet_locked).toBe(false);
    expect(result.items[0].net_cash).toBe(1000);
  });

  it('returns null last_location for a rider with no telemetry', async () => {
    prisma.riders.findMany.mockResolvedValue([
      {
        id: 'r1',
        is_active: true,
        vehicle: '',
        plate_no: '',
        rating: 5,
        acceptance_rate: 1,
        total_trips: 0,
        profile: { full_name: 'A', phone: '1' },
      },
    ]);

    const result = await service.getRiders(query(AdminRidersQueryDto, {}));

    expect(result.items[0].last_location).toBeNull();
  });

  it('filters by on_duty (maps to is_active)', async () => {
    await service.getRiders(query(AdminRidersQueryDto, { on_duty: true }));

    const call = prisma.riders.findMany.mock.calls[0][0];
    expect(call.where.is_active).toBe(true);
  });

  it('applies pagination and returns the envelope', async () => {
    prisma.riders.count.mockResolvedValue(42);

    const result = await service.getRiders(
      query(AdminRidersQueryDto, { limit: 5, offset: 10 }),
    );

    const call = prisma.riders.findMany.mock.calls[0][0];
    expect(call.take).toBe(5);
    expect(call.skip).toBe(10);
    expect(result.total).toBe(42);
    expect(result.limit).toBe(5);
    expect(result.offset).toBe(10);
  });
});

describe('AdminService.getMerchants', () => {
  let service: AdminService;
  let prisma: {
    merchants: { findMany: FindManyMock; count: jest.Mock };
    orders: { groupBy: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      merchants: {
        findMany: jest.fn<Promise<unknown[]>, [FindManyCall]>(),
        count: jest.fn(),
      },
      orders: { groupBy: jest.fn() },
    };
    prisma.merchants.findMany.mockResolvedValue([]);
    prisma.merchants.count.mockResolvedValue(0);
    prisma.orders.groupBy.mockResolvedValue([]);
    service = new AdminService(
      prisma as unknown as PrismaService,
      {} as LedgerService,
    );
  });

  it('converts delivery_fee/min_order/rating and attaches active_orders count', async () => {
    prisma.merchants.findMany.mockResolvedValue([
      {
        id: 'm1',
        name: 'Nena',
        delivery_fee: 3000n,
        min_order: 10000n,
        rating: 4.5,
        is_open: true,
      },
    ]);
    prisma.orders.groupBy.mockResolvedValue([
      { merchant_id: 'm1', _count: { _all: 4 } },
    ]);

    const result = await service.getMerchants(
      query(AdminMerchantsQueryDto, {}),
    );

    expect(result.items[0]).toMatchObject({
      id: 'm1',
      delivery_fee: 3000,
      min_order: 10000,
      active_orders: 4,
    });
  });

  it('filters by is_open', async () => {
    await service.getMerchants(
      query(AdminMerchantsQueryDto, { is_open: false }),
    );

    const call = prisma.merchants.findMany.mock.calls[0][0];
    expect(call.where.is_open).toBe(false);
  });

  it('defaults active_orders to 0 for a merchant with no active orders', async () => {
    prisma.merchants.findMany.mockResolvedValue([
      {
        id: 'm1',
        name: 'Nena',
        delivery_fee: 3000n,
        min_order: 10000n,
        rating: 4.5,
        is_open: true,
      },
    ]);

    const result = await service.getMerchants(
      query(AdminMerchantsQueryDto, {}),
    );

    expect(result.items[0].active_orders).toBe(0);
  });
});

describe('AdminService.getLedgerTransactions', () => {
  let service: AdminService;
  let prisma: {
    rider_wallet_transactions: { findMany: FindManyMock; count: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      rider_wallet_transactions: {
        findMany: jest.fn<Promise<unknown[]>, [FindManyCall]>(),
        count: jest.fn(),
      },
    };
    prisma.rider_wallet_transactions.findMany.mockResolvedValue([]);
    prisma.rider_wallet_transactions.count.mockResolvedValue(0);
    service = new AdminService(
      prisma as unknown as PrismaService,
      {} as LedgerService,
    );
  });

  it('returns string id/amount and joins rider_name from the profile', async () => {
    prisma.rider_wallet_transactions.findMany.mockResolvedValue([
      {
        id: 7n,
        rider_id: 'r1',
        type: 'credit_delivery_reward',
        amount: 8000n,
        order_id: 'o1',
        created_at: new Date('2026-07-05T00:00:00.000Z'),
        rider: { profile: { full_name: 'Pedro' } },
      },
    ]);
    prisma.rider_wallet_transactions.count.mockResolvedValue(1);

    const result = await service.getLedgerTransactions(
      query(AdminLedgerQueryDto, {}),
    );

    expect(result.items[0]).toEqual({
      id: '7',
      rider_id: 'r1',
      rider_name: 'Pedro',
      type: 'credit_delivery_reward',
      amount: '8000',
      order_id: 'o1',
      created_at: new Date('2026-07-05T00:00:00.000Z'),
    });
  });

  it('filters by rider_id/order_id/type and orders by created_at desc', async () => {
    await service.getLedgerTransactions(
      query(AdminLedgerQueryDto, {
        rider_id: 'r1',
        order_id: 'o1',
        type: 'debit_cod_order',
      }),
    );

    const call = prisma.rider_wallet_transactions.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      rider_id: 'r1',
      order_id: 'o1',
      type: 'debit_cod_order',
    });
    expect(call.orderBy).toEqual({ created_at: 'desc' });
  });

  it('returns the pagination envelope', async () => {
    prisma.rider_wallet_transactions.count.mockResolvedValue(99);

    const result = await service.getLedgerTransactions(
      query(AdminLedgerQueryDto, { limit: 10, offset: 20 }),
    );

    expect(result.total).toBe(99);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(20);
  });
});
