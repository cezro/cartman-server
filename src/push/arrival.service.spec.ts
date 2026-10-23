import { ArrivalService } from './arrival.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * H10 — nothing notices the rider arrived.
 *
 * Every transition is a manual tap, so `arrived_at_merchant` is only as
 * accurate as a busy rider's memory. The data to do better already exists:
 * `rider_locations` streams a fix per order, and orders carry the drop-off.
 * So this is a comparison, not new plumbing.
 *
 * Notification-only by decision: a new order status would mean touching every
 * `switch` over OrderStatus in both apps, and auto-advancing on a GPS fix puts
 * a noisy sensor on the order's write path.
 */
describe('ArrivalService', () => {
  let prisma: {
    orders: { findMany: jest.Mock };
    rider_locations: { findMany: jest.Mock };
    merchant_users: { findMany: jest.Mock };
    push_outbox: { findMany: jest.Mock; createMany: jest.Mock };
  };
  let service: ArrivalService;

  // Iloilo City Proper — the merchant. ~40m away, and ~1.2km away.
  const MERCHANT = { lat: 10.6995, lng: 122.5688 };
  const NEAR_MERCHANT = { lat: 10.69985, lng: 122.5688 };
  const FAR = { lat: 10.71, lng: 122.5688 };
  const DROPOFF = { lat: 10.7145, lng: 122.5996 };
  const NEAR_DROPOFF = { lat: 10.71485, lng: 122.5996 };

  const order = (over: Record<string, unknown> = {}) => ({
    id: 'ord-1',
    ref_no: 'CT-1001',
    customer_id: 'cust-1',
    assigned_rider_id: 'rider-1',
    merchant_id: 'merch-1',
    status: 'accepted',
    dropoff_lat: DROPOFF.lat,
    dropoff_lng: DROPOFF.lng,
    merchant: {
      name: 'Kusina ni Aling Nena',
      lat: MERCHANT.lat,
      lng: MERCHANT.lng,
    },
    ...over,
  });

  const fix = (p: { lat: number; lng: number }, over = {}) => ({
    order_id: 'ord-1',
    lat: p.lat,
    lng: p.lng,
    recorded_at: new Date(),
    ...over,
  });

  beforeEach(() => {
    prisma = {
      orders: { findMany: jest.fn().mockResolvedValue([]) },
      rider_locations: { findMany: jest.fn().mockResolvedValue([]) },
      merchant_users: {
        // merchant_id matters: members are scoped to their own store, or a
        // rider arriving at one shop notifies the owner of another.
        findMany: jest
          .fn()
          .mockResolvedValue([{ user_id: 'owner-1', merchant_id: 'merch-1' }]),
      },
      push_outbox: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    service = new ArrivalService(prisma as unknown as PrismaService);
  });

  it('tells the store when a pre-pickup rider reaches the merchant', async () => {
    prisma.orders.findMany.mockResolvedValue([order({ status: 'accepted' })]);
    prisma.rider_locations.findMany.mockResolvedValue([fix(NEAR_MERCHANT)]);

    const result = await service.sweep();

    const [{ data: rows }] = prisma.push_outbox.createMany.mock.calls[0] as [
      { data: { user_id: string; event: string }[] },
    ];
    // The store is who needs this: food sits under a heat lamp, or the rider
    // waits, and neither of them knows about the other.
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe('owner-1');
    expect(rows[0].event).toBe('rider.at_merchant');
    expect(result).toEqual({ arrivals: 1, notified: 1 });
  });

  it('tells the customer when a carrying rider reaches the drop-off', async () => {
    prisma.orders.findMany.mockResolvedValue([order({ status: 'in_transit' })]);
    prisma.rider_locations.findMany.mockResolvedValue([fix(NEAR_DROPOFF)]);

    const result = await service.sweep();

    const [{ data: rows }] = prisma.push_outbox.createMany.mock.calls[0] as [
      { data: { user_id: string; event: string }[] },
    ];
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe('cust-1');
    expect(rows[0].event).toBe('rider.at_dropoff');
    expect(result).toEqual({ arrivals: 1, notified: 1 });
  });

  // cross-lifecycle-17: orders with no store were skipped before pickup, so a
  // Pasakay passenger was never told the driver had arrived.
  const storeless = (type: string, status: string) =>
    order({
      type,
      status,
      merchant_id: null,
      merchant: null,
      pickup_lat: MERCHANT.lat,
      pickup_lng: MERCHANT.lng,
    });

  it('tells a Pasakay passenger the driver has reached the pickup', async () => {
    prisma.orders.findMany.mockResolvedValue([storeless('ride', 'accepted')]);
    prisma.rider_locations.findMany.mockResolvedValue([fix(NEAR_MERCHANT)]);

    await service.sweep();

    const [{ data: rows }] = prisma.push_outbox.createMany.mock.calls[0] as [
      { data: { user_id: string; event: string; title: string }[] },
    ];
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe('cust-1');
    expect(rows[0].event).toBe('rider.at_pickup');
    expect(rows[0].title).toBe('Your driver is here');
    expect(prisma.merchant_users.findMany).not.toHaveBeenCalled();
  });

  it('does not tell a ride passenger the rider is at their own destination', async () => {
    prisma.orders.findMany.mockResolvedValue([storeless('ride', 'in_transit')]);
    prisma.rider_locations.findMany.mockResolvedValue([fix(NEAR_DROPOFF)]);

    expect(await service.sweep()).toEqual({ arrivals: 0, notified: 0 });
  });

  it('tells a courier customer the rider is at the pickup point', async () => {
    prisma.orders.findMany.mockResolvedValue([
      storeless('pickup_delivery', 'accepted'),
    ]);
    prisma.rider_locations.findMany.mockResolvedValue([fix(NEAR_MERCHANT)]);

    await service.sweep();

    const [{ data: rows }] = prisma.push_outbox.createMany.mock.calls[0] as [
      { data: { event: string; title: string }[] },
    ];
    expect(rows[0].event).toBe('rider.at_pickup');
    expect(rows[0].title).toBe('Your rider is at the pickup');
  });

  // ── Review findings on this sweep, each pinned by the shape of the query
  // rather than by its result — the defects were invisible in the outcome and
  // only showed up in what was sent to Postgres.

  it('bounds the de-dup read by recipient and by a recent window', async () => {
    prisma.orders.findMany.mockResolvedValue([order({ status: 'in_transit' })]);
    prisma.rider_locations.findMany.mockResolvedValue([fix(NEAR_DROPOFF)]);

    await service.sweep();

    const [args] = prisma.push_outbox.findMany.mock.calls[0] as [
      {
        where: {
          user_id?: { in: string[] };
          created_at?: { gte: Date };
          event: { in: string[] };
        };
      },
    ];
    // Unbounded, this read every arrival notification ever written, once a
    // minute, forever. `push_outbox`'s only index is partial (`where sent_at
    // is null`) and these rows are sent, so nothing can serve the query —
    // keeping the row set small is the entire defence.
    expect(args.where.user_id?.in).toEqual(['cust-1']);
    expect(args.where.created_at?.gte).toBeInstanceOf(Date);
    expect(args.where.event.in).toEqual([
      'rider.at_merchant',
      'rider.at_dropoff',
      'rider.at_pickup',
    ]);
  });

  it('does not read the outbox at all when nobody has arrived', async () => {
    prisma.orders.findMany.mockResolvedValue([order({ status: 'accepted' })]);
    prisma.rider_locations.findMany.mockResolvedValue([fix(FAR)]);

    await service.sweep();

    // Most passes find nobody, and they should cost one query, not three.
    // Same reasoning that already defers the `merchant_users` join.
    expect(prisma.push_outbox.findMany).not.toHaveBeenCalled();
    expect(prisma.merchant_users.findMany).not.toHaveBeenCalled();
  });

  it('orders the live-order batch instead of sampling it', async () => {
    await service.sweep();

    const [args] = prisma.orders.findMany.mock.calls[0] as [
      { orderBy?: unknown; take?: number },
    ];
    // An unordered LIMIT in Postgres returns an arbitrary 200 rows, and which
    // 200 can change between passes over identical data — so past 200 live
    // orders an order could sit inside the radius and never be picked, with
    // nothing recording that it was skipped.
    expect(args.orderBy).toEqual({ updated_at: 'asc' });
    expect(args.take).toBe(200);
  });

  it('does not fire when the rider is still far away', async () => {
    prisma.orders.findMany.mockResolvedValue([order({ status: 'accepted' })]);
    prisma.rider_locations.findMany.mockResolvedValue([fix(FAR)]);

    const result = await service.sweep();

    expect(prisma.push_outbox.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ arrivals: 0, notified: 0 });
  });

  it('measures a pre-pickup rider against the merchant, not the drop-off', async () => {
    // Sitting on the customer's doorstep before collecting the food is not an
    // arrival at the store. Comparing against the wrong endpoint would fire
    // "the rider is outside" to a store the rider has not gone to yet.
    prisma.orders.findMany.mockResolvedValue([order({ status: 'accepted' })]);
    prisma.rider_locations.findMany.mockResolvedValue([fix(NEAR_DROPOFF)]);

    const result = await service.sweep();

    expect(result).toEqual({ arrivals: 0, notified: 0 });
  });

  it('measures a carrying rider against the drop-off, not the merchant', async () => {
    // The rider is standing at the store they just collected from; that is not
    // an arrival at the customer's door.
    prisma.orders.findMany.mockResolvedValue([order({ status: 'picked_up' })]);
    prisma.rider_locations.findMany.mockResolvedValue([fix(NEAR_MERCHANT)]);

    const result = await service.sweep();

    expect(result).toEqual({ arrivals: 0, notified: 0 });
  });

  it('does not announce the same arrival twice', async () => {
    prisma.orders.findMany.mockResolvedValue([order({ status: 'accepted' })]);
    prisma.rider_locations.findMany.mockResolvedValue([fix(NEAR_MERCHANT)]);
    prisma.push_outbox.findMany.mockResolvedValue([
      { event: 'rider.at_merchant', data: { order_id: 'ord-1' } },
    ]);

    const result = await service.sweep();

    // The sweep runs on a timer and the rider stays parked outside, so without
    // this the store's phone buzzes every pass until pickup.
    expect(prisma.push_outbox.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ arrivals: 0, notified: 0 });
  });

  it('an at-merchant announcement does not suppress the later at-dropoff one', async () => {
    prisma.orders.findMany.mockResolvedValue([order({ status: 'in_transit' })]);
    prisma.rider_locations.findMany.mockResolvedValue([fix(NEAR_DROPOFF)]);
    prisma.push_outbox.findMany.mockResolvedValue([
      { event: 'rider.at_merchant', data: { order_id: 'ord-1' } },
    ]);

    const result = await service.sweep();

    // Both happen on the same order. Keying the de-dupe on order_id alone
    // would mean the customer is never told the rider is at the door.
    expect(result).toEqual({ arrivals: 1, notified: 1 });
  });

  it('skips an order whose endpoint has no coordinates', async () => {
    prisma.orders.findMany.mockResolvedValue([
      order({ status: 'in_transit', dropoff_lat: null, dropoff_lng: null }),
    ]);
    prisma.rider_locations.findMany.mockResolvedValue([fix(NEAR_DROPOFF)]);

    const result = await service.sweep();

    // merchants.lat/lng and orders.dropoff_* are all nullable. Treating a
    // missing coordinate as 0,0 puts the endpoint in the Gulf of Guinea and
    // nothing is ever within range of it — but it would still cost a fan-out.
    expect(result).toEqual({ arrivals: 0, notified: 0 });
  });

  it('asks only for fresh fixes', async () => {
    prisma.orders.findMany.mockResolvedValue([order({ status: 'accepted' })]);

    await service.sweep();

    // The client queues fixes through a dead zone and drains them on
    // reconnect, so an old fix says where the rider *was*. Announcing on one
    // tells a store someone is outside who left long ago.
    //
    // Asserted on the query rather than by feeding a stale row through, because
    // the bound is the query's job — a mock that ignores `where` would let this
    // pass no matter what the service did.
    const [call] = prisma.rider_locations.findMany.mock.calls[0] as [
      { where: { recorded_at: { gte: Date } } },
    ];
    const floor = call.where.recorded_at.gte;
    expect(floor).toBeInstanceOf(Date);
    const ageMs = Date.now() - floor.getTime();
    expect(ageMs).toBeGreaterThan(0);
    // Minutes, not hours: a fix old enough to be wrong must not qualify.
    expect(ageMs).toBeLessThanOrEqual(10 * 60_000);
  });

  it('writes nothing when no order has a rider on it', async () => {
    const result = await service.sweep();

    expect(prisma.rider_locations.findMany).not.toHaveBeenCalled();
    expect(prisma.push_outbox.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ arrivals: 0, notified: 0 });
  });

  it('the scheduled entry point swallows errors rather than killing the process', async () => {
    prisma.orders.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.handleCron()).resolves.toBeUndefined();
  });
});
