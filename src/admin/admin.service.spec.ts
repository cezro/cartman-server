import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';

// Typed call shapes so mock.calls entries aren't `any` — mirrors the typed
// mock pattern in admin.service.mutations.spec.ts.
interface GroupByCall {
  by: string[];
  where?: { created_at?: { gte: Date } };
}
interface CountCall {
  where?: {
    status?: unknown;
    updated_at?: { gte: Date };
  };
}

describe('AdminService.getStats', () => {
  let service: AdminService;
  let prisma: {
    orders: {
      count: jest.Mock<Promise<number>, [CountCall]>;
      findMany: jest.Mock;
    };
    riders: { count: jest.Mock };
    rider_wallet_transactions: {
      groupBy: jest.Mock<Promise<unknown[]>, [GroupByCall]>;
    };
  };

  function defaultMocks() {
    prisma.orders.count.mockResolvedValue(0);
    prisma.orders.findMany.mockResolvedValue([]);
    prisma.riders.count.mockResolvedValue(0);
    prisma.rider_wallet_transactions.groupBy.mockResolvedValue([]);
  }

  beforeEach(() => {
    prisma = {
      orders: {
        count: jest.fn<Promise<number>, [CountCall]>(),
        findMany: jest.fn(),
      },
      riders: { count: jest.fn() },
      rider_wallet_transactions: {
        groupBy: jest.fn<Promise<unknown[]>, [GroupByCall]>(),
      },
    };
    defaultMocks();
    service = new AdminService(
      prisma as unknown as PrismaService,
      {} as LedgerService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('folds per-rider net cash from a single groupBy using the CREDIT/DEBIT sign rule, never looping per rider', async () => {
    // rider r1: +2000 (remittance) - 5000 (cod) = -3000 (owing)
    // rider r2: -1000 (commission) = -1000 (owing)
    // rider r3: +2000 (remittance) = +2000 (not owing)
    prisma.rider_wallet_transactions.groupBy.mockImplementation(
      ({ by }: { by: string[] }) => {
        // Two distinct groupBy shapes are used: one for today's COD
        // roll-up (by: ['type']), one for all-time net cash (by:
        // ['rider_id', 'type']). Distinguish by the `by` array.
        if (by.includes('rider_id')) {
          return Promise.resolve([
            {
              rider_id: 'r1',
              type: 'credit_remittance',
              _sum: { amount: 2000n },
            },
            {
              rider_id: 'r1',
              type: 'debit_cod_order',
              _sum: { amount: 5000n },
            },
            {
              rider_id: 'r2',
              type: 'debit_commission',
              _sum: { amount: 1000n },
            },
            {
              rider_id: 'r3',
              type: 'credit_remittance',
              _sum: { amount: 2000n },
            },
          ]);
        }
        return Promise.resolve([]);
      },
    );

    const result = await service.getStats();

    expect(result.remittance.riders_owing).toBe(2);
    expect(result.remittance.outstanding_total).toBe(4000);
    // Exactly one call must carry rider_id — asserts we never loop
    // getNetCash per rider (one groupBy call for the whole fold).
    const riderGroupByCalls =
      prisma.rider_wallet_transactions.groupBy.mock.calls.filter(([args]) =>
        args.by.includes('rider_id'),
      );
    expect(riderGroupByCalls).toHaveLength(1);
  });

  it('returns avg_delivery_secs_today: null when no orders delivered today', async () => {
    prisma.orders.findMany.mockResolvedValue([]);

    const result = await service.getStats();

    expect(result.avg_delivery_secs_today).toBeNull();
  });

  it('computes avg_delivery_secs_today from today delivered orders', async () => {
    prisma.orders.findMany.mockResolvedValue([
      {
        created_at: new Date('2026-07-05T01:00:00.000Z'),
        updated_at: new Date('2026-07-05T01:10:00.000Z'), // 600s
      },
      {
        created_at: new Date('2026-07-05T02:00:00.000Z'),
        updated_at: new Date('2026-07-05T02:20:00.000Z'), // 1200s
      },
    ]);

    const result = await service.getStats();

    expect(result.avg_delivery_secs_today).toBe(900);
  });

  // updated_at is bumped by rider_submit_pod writing the POD photo after the
  // handover, so on any order with proof of delivery it measures
  // order-to-paperwork. delivered_at is the actual transition.
  it('prefers delivered_at over updated_at when it is present', async () => {
    prisma.orders.findMany.mockResolvedValue([
      {
        created_at: new Date('2026-07-05T01:00:00.000Z'),
        delivered_at: new Date('2026-07-05T01:10:00.000Z'), // 600s — the truth
        updated_at: new Date('2026-07-05T01:45:00.000Z'), // POD written later
      },
    ]);

    const result = await service.getStats();

    expect(result.avg_delivery_secs_today).toBe(600);
  });

  // Rows delivered before the column existed, and any delivery this server
  // completed before it started stamping, have no delivered_at. Dropping them
  // would narrow the average to a subset rather than report it over the day.
  it('falls back to updated_at for rows with no delivered_at, mixing both', async () => {
    prisma.orders.findMany.mockResolvedValue([
      {
        created_at: new Date('2026-07-05T01:00:00.000Z'),
        delivered_at: new Date('2026-07-05T01:10:00.000Z'), // 600s
        updated_at: new Date('2026-07-05T01:45:00.000Z'),
      },
      {
        created_at: new Date('2026-07-05T02:00:00.000Z'),
        delivered_at: null, // legacy row
        updated_at: new Date('2026-07-05T02:20:00.000Z'), // 1200s
      },
    ]);

    const result = await service.getStats();

    expect(result.avg_delivery_secs_today).toBe(900);
  });

  it('scopes the *_today queries to Manila midnight', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-05T04:00:00.000Z')); // 12:00 Manila

    await service.getStats();

    const deliveredTodayCall = prisma.orders.count.mock.calls.find(
      ([args]) => args.where?.status === 'delivered',
    );
    expect(deliveredTodayCall?.[0].where?.updated_at?.gte.toISOString()).toBe(
      '2026-07-04T16:00:00.000Z',
    );

    const codGroupByCall =
      prisma.rider_wallet_transactions.groupBy.mock.calls.find(
        ([args]) => !args.by.includes('rider_id'),
      );
    expect(codGroupByCall?.[0].where?.created_at?.gte.toISOString()).toBe(
      '2026-07-04T16:00:00.000Z',
    );
  });

  it('reads cod_today expected/remitted from the type-scoped groupBy', async () => {
    prisma.rider_wallet_transactions.groupBy.mockImplementation(
      ({ by }: { by: string[] }) => {
        if (!by.includes('rider_id')) {
          return Promise.resolve([
            { type: 'debit_cod_order', _sum: { amount: 15000n } },
            { type: 'credit_remittance', _sum: { amount: 9000n } },
          ]);
        }
        return Promise.resolve([]);
      },
    );

    const result = await service.getStats();

    expect(result.cod_today.expected).toBe(15000);
    expect(result.cod_today.remitted).toBe(9000);
  });

  it('reads orders and fleet counts from the corresponding count() calls', async () => {
    prisma.orders.count
      .mockResolvedValueOnce(7) // active
      .mockResolvedValueOnce(3) // unassigned
      .mockResolvedValueOnce(4) // delivered_today
      .mockResolvedValueOnce(1) // canceled_today
      .mockResolvedValueOnce(2); // delivery_failed_today
    prisma.riders.count
      .mockResolvedValueOnce(5) // on_duty
      .mockResolvedValueOnce(12); // total

    const result = await service.getStats();

    expect(result.orders).toEqual({
      active: 7,
      unassigned: 3,
      delivered_today: 4,
      canceled_today: 1,
      delivery_failed_today: 2,
    });
    expect(result.fleet).toEqual({ on_duty: 5, total: 12 });
  });

  // A failed delivery is closed, not in flight. Before delivery_failed became
  // terminal these two counts read it as active, which would have overstated
  // the live queue on the dashboard and in every per-rider/per-merchant
  // active_orders figure.
  it('excludes delivery_failed from the active count and counts it on its own clock', async () => {
    await service.getStats();

    const activeCall = prisma.orders.count.mock.calls[0][0];
    expect(activeCall.where.status.notIn).toEqual([
      'delivered',
      'canceled',
      'delivery_failed',
    ]);

    const failedCall = prisma.orders.count.mock.calls[4][0];
    expect(failedCall.where.status).toBe('delivery_failed');
    // delivery_failed_at, not updated_at — a later touch of the row must not
    // drag the failure into tomorrow's count.
    expect(failedCall.where.delivery_failed_at).toBeDefined();
    expect(failedCall.where.updated_at).toBeUndefined();
  });
});
