import { FeedService } from './feed.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { order_status, order_type } from '@prisma/client';

// Fixed "now" for deterministic age scoring across all tests.
const NOW = new Date('2026-07-05T12:00:00.000Z');

function minutesAgo(mins: number): Date {
  return new Date(NOW.getTime() - mins * 60_000);
}

function baseOrder(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'order-1',
    type: order_type.food,
    status: order_status.ready_for_pickup,
    assigned_rider_id: null,
    created_at: minutesAgo(5),
    delivery_payout: 5000n,
    pickup_lat: null,
    pickup_lng: null,
    order_items: [],
    ...overrides,
  };
}

describe('FeedService', () => {
  let service: FeedService;
  let prisma: {
    orders: { findMany: jest.Mock };
    rider_locations: { findFirst: jest.Mock };
  };
  let ledgerService: { getNetCash: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);

    prisma = {
      orders: { findMany: jest.fn().mockResolvedValue([]) },
      rider_locations: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    ledgerService = { getNetCash: jest.fn().mockResolvedValue(0n) };

    service = new FeedService(
      prisma as unknown as PrismaService,
      ledgerService as unknown as LedgerService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('honors an explicit FEED_W_*=0 instead of falling back to the default', async () => {
    process.env.FEED_W_AGE = '0';
    try {
      const zeroAgeService = new FeedService(
        prisma as unknown as PrismaService,
        ledgerService as unknown as LedgerService,
      );
      // With the age weight zeroed, an older otherwise-identical order gains
      // nothing — the tie-break (older first) decides order, but scores match.
      prisma.orders.findMany.mockResolvedValue([
        baseOrder({ id: 'older', created_at: minutesAgo(20) }),
        baseOrder({ id: 'newer', created_at: minutesAgo(1) }),
      ]);
      const result = await zeroAgeService.rankedFeed('rider-1');
      expect(result[0].score).toBe(result[1].score);
    } finally {
      delete process.env.FEED_W_AGE;
    }
  });

  it('1. an older order outranks an identical newer order (age term)', async () => {
    prisma.orders.findMany.mockResolvedValue([
      baseOrder({ id: 'older', created_at: minutesAgo(20) }),
      baseOrder({ id: 'newer', created_at: minutesAgo(1) }),
    ]);

    const result = await service.rankedFeed('rider-1');

    expect(result[0].order.id).toBe('older');
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it('2. a nearer pickup outranks a farther pickup (fixed rider position)', async () => {
    // Rider at (10, 122). "near" order pickup is very close; "far" is ~ far away.
    prisma.rider_locations.findFirst.mockResolvedValue({
      lat: 10,
      lng: 122,
      recorded_at: minutesAgo(1),
    });
    prisma.orders.findMany.mockResolvedValue([
      baseOrder({
        id: 'far',
        created_at: minutesAgo(5),
        pickup_lat: 10.5,
        pickup_lng: 122.5,
      }),
      baseOrder({
        id: 'near',
        created_at: minutesAgo(5),
        pickup_lat: 10.01,
        pickup_lng: 122.01,
      }),
    ]);

    const result = await service.rankedFeed('rider-1');

    expect(result[0].order.id).toBe('near');
    expect(result[0].score).toBeGreaterThan(result[1].score);
    expect(result[0].distance_km).not.toBeNull();
  });

  it('3. no telemetry and no lat/lng params -> proximity 0, still ranked, distance_km null', async () => {
    prisma.rider_locations.findFirst.mockResolvedValue(null);
    prisma.orders.findMany.mockResolvedValue([
      baseOrder({ id: 'order-1', pickup_lat: 10, pickup_lng: 122 }),
    ]);

    const result = await service.rankedFeed('rider-1');

    expect(result).toHaveLength(1);
    expect(result[0].distance_km).toBeNull();
  });

  it('4. ride outranks errand at equal age/payout/distance', async () => {
    prisma.orders.findMany.mockResolvedValue([
      baseOrder({
        id: 'errand',
        type: order_type.errand,
        created_at: minutesAgo(5),
        delivery_payout: 5000n,
      }),
      baseOrder({
        id: 'ride',
        type: order_type.ride,
        created_at: minutesAgo(5),
        delivery_payout: 5000n,
      }),
    ]);

    const result = await service.rankedFeed('rider-1');

    expect(result[0].order.id).toBe('ride');
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it('5. age caps at 30 min — 35-min and 30-min orders tie on age term (equal scores otherwise)', async () => {
    prisma.orders.findMany.mockResolvedValue([
      baseOrder({
        id: 'thirty-five',
        created_at: minutesAgo(35),
        delivery_payout: 5000n,
      }),
      baseOrder({
        id: 'thirty',
        created_at: minutesAgo(30),
        delivery_payout: 5000n,
      }),
    ]);

    const result = await service.rankedFeed('rider-1');

    expect(result[0].score).toBe(result[1].score);
  });

  it('6. returns at most 20 entries, sorted desc by score', async () => {
    const orders = Array.from({ length: 30 }, (_, i) =>
      baseOrder({
        id: `order-${i}`,
        created_at: minutesAgo(i),
        delivery_payout: BigInt(1000 * (i + 1)),
      }),
    );
    prisma.orders.findMany.mockResolvedValue(orders);

    const result = await service.rankedFeed('rider-1');

    expect(result.length).toBeLessThanOrEqual(20);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
    }
  });

  it('uses lat/lng query params when no fresh telemetry is available', async () => {
    prisma.rider_locations.findFirst.mockResolvedValue(null);
    prisma.orders.findMany.mockResolvedValue([
      baseOrder({ id: 'order-1', pickup_lat: 10.01, pickup_lng: 122.01 }),
    ]);

    const result = await service.rankedFeed('rider-1', 10, 122);

    expect(result[0].distance_km).not.toBeNull();
  });

  it("leaves tricycle-only orders out of a motorcycle rider's feed", async () => {
    await service.rankedFeed(
      'rider-1',
      undefined,
      undefined,
      'Honda Click 125i',
    );

    expect(prisma.orders.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ required_vehicle: null }, { required_vehicle: 'motorcycle' }],
        }) as Record<string, unknown>,
      }),
    );
  });

  it('shows a tricycle rider the orders waiting for one', async () => {
    await service.rankedFeed('rider-1', undefined, undefined, 'tricycle');

    expect(prisma.orders.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ required_vehicle: null }, { required_vehicle: 'tricycle' }],
        }) as Record<string, unknown>,
      }),
    );
  });

  it('queries candidates with take 50, orderBy created_at asc, including order_items and order_stops', async () => {
    await service.rankedFeed('rider-1');

    expect(prisma.orders.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
        orderBy: { created_at: 'asc' },
        include: expect.objectContaining({
          order_items: true,
          // Multi-stop cards/active screens need the route without a second
          // round trip; serializeOrder passes the rows through.
          order_stops: true,
        }) as Record<string, unknown>,
      }),
    );
  });

  describe('accept-window expiry (R-4.1)', () => {
    it('stamps each entry with expires_at = created_at + 5 minutes (default window)', async () => {
      prisma.orders.findMany.mockResolvedValue([
        baseOrder({ id: 'order-1', created_at: minutesAgo(2) }),
      ]);

      const [entry] = await service.rankedFeed('rider-1');

      expect(entry.expires_at).toBe(
        new Date(minutesAgo(2).getTime() + 5 * 60_000).toISOString(),
      );
    });

    it('honors FEED_ACCEPT_WINDOW_MINUTES as the window length', async () => {
      process.env.FEED_ACCEPT_WINDOW_MINUTES = '2';
      try {
        const windowed = new FeedService(
          prisma as unknown as PrismaService,
          ledgerService as unknown as LedgerService,
        );
        prisma.orders.findMany.mockResolvedValue([
          baseOrder({ id: 'order-1', created_at: minutesAgo(1) }),
        ]);

        const [entry] = await windowed.rankedFeed('rider-1');

        expect(entry.expires_at).toBe(
          new Date(minutesAgo(1).getTime() + 2 * 60_000).toISOString(),
        );
      } finally {
        delete process.env.FEED_ACCEPT_WINDOW_MINUTES;
      }
    });

    it('an already-expired order still appears in the feed (the window is urgency, not a lifecycle rule)', async () => {
      prisma.orders.findMany.mockResolvedValue([
        baseOrder({ id: 'old-order', created_at: minutesAgo(45) }),
      ]);

      const result = await service.rankedFeed('rider-1');

      expect(result.map((e) => e.order.id as string)).toContain('old-order');
      expect(new Date(result[0].expires_at).getTime()).toBeLessThan(
        NOW.getTime(),
      );
    });
  });
});
