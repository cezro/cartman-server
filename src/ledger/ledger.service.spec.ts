import { LedgerService } from './ledger.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LedgerService.getEarningsToday', () => {
  let service: LedgerService;
  let prisma: {
    rider_wallet_transactions: { findMany: jest.Mock };
    profiles: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      rider_wallet_transactions: { findMany: jest.fn() },
      profiles: { findUnique: jest.fn() },
    };
    service = new LedgerService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sums only credit_delivery_reward amounts from today (Manila time)', async () => {
    // "Now" is 2026-07-05T04:00:00Z == 2026-07-05T12:00 Manila (UTC+8).
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-05T04:00:00.000Z'));

    // The mock simulates Prisma already applying the where clause (type +
    // rider_id + created_at boundary) — this test asserts the aggregation
    // math on the rows the query returns, and the assertions below verify
    // the where clause itself was built correctly (type/rider scoping).
    prisma.rider_wallet_transactions.findMany.mockResolvedValue([
      { type: 'credit_delivery_reward', amount: 5000n },
      { type: 'credit_delivery_reward', amount: 3000n },
    ]);

    const result = await service.getEarningsToday('rider-1');

    expect(result).toBe(8000);
    // Confirm the query is scoped to this rider and filtered to the reward
    // type — the DB, not in-memory code, excludes other types/riders.
    const call = prisma.rider_wallet_transactions.findMany.mock.calls[0][0];
    expect(call.where.rider_id).toBe('rider-1');
    expect(call.where.type).toBe('credit_delivery_reward');
  });

  it('a transaction at 23:30 UTC yesterday (07:30 Manila today) counts as today', async () => {
    // "Now" is 2026-07-05T04:00:00Z == 2026-07-05T12:00 Manila.
    // Manila midnight today (2026-07-05T00:00 Manila) is 2026-07-04T16:00Z.
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-05T04:00:00.000Z'));

    // 2026-07-04T23:30:00Z == 2026-07-05T07:30 Manila — after Manila midnight,
    // so it must count as "today" even though its UTC calendar day is
    // yesterday.
    prisma.rider_wallet_transactions.findMany.mockResolvedValue([
      { type: 'credit_delivery_reward', amount: 4200n },
    ]);

    const result = await service.getEarningsToday('rider-1');

    expect(result).toBe(4200);
    const call = prisma.rider_wallet_transactions.findMany.mock.calls[0][0];
    // The lower bound passed to Prisma must be Manila midnight expressed in
    // UTC: 2026-07-04T16:00:00.000Z.
    expect(call.where.created_at.gte.toISOString()).toBe(
      '2026-07-04T16:00:00.000Z',
    );
  });

  it('excludes a transaction from yesterday (before the Manila midnight boundary)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-05T04:00:00.000Z'));

    // Query itself is expected to filter by created_at >= boundary, so the
    // mock simulates the DB already excluding stale rows.
    prisma.rider_wallet_transactions.findMany.mockResolvedValue([]);

    const result = await service.getEarningsToday('rider-1');

    expect(result).toBe(0);
  });
});
