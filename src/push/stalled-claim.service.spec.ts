import {
  StalledClaimService,
  RELEASE_AFTER_MINUTES,
  MAX_AUTO_RELEASES,
} from './stalled-claim.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * H17, the acting half.
 *
 * A rider claims an order and then does nothing — never reaches the store,
 * never releases it. The order is invisible to every other rider for as long
 * as that claim stands, so no amount of waiting fixes it. This is the one
 * stuck-order case with an automatic answer that costs nothing if it is wrong:
 * a release has no ledger consequence, unlike a cancel.
 */
describe('StalledClaimService', () => {
  interface UpdateManyCall {
    where: { id: string; status: string; assigned_rider_id: string };
    data: { assigned_rider_id: null; status: string };
  }

  let prisma: {
    orders: { findMany: jest.Mock; updateMany: jest.Mock; groupBy: jest.Mock };
    order_assignment_events: { groupBy: jest.Mock; create: jest.Mock };
    push_outbox: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: StalledClaimService;

  const stalled = (over: Record<string, unknown> = {}) => ({
    id: 'ord-1',
    ref_no: 'CT-1001',
    assigned_rider_id: 'rider-1',
    ...over,
  });

  beforeEach(() => {
    prisma = {
      orders: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        // Riders busy on another live order — none unless a test says so.
        groupBy: jest.fn().mockResolvedValue([]),
      },
      order_assignment_events: {
        groupBy: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
      },
      push_outbox: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
    };
    // The real client hands the callback a transactional `tx` with the same
    // shape; the mock hands it the same object so the assertions below see
    // every write the transaction makes.
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );
    service = new StalledClaimService(prisma as unknown as PrismaService);
  });

  const auditRow = () =>
    (
      prisma.order_assignment_events.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ]
    )[0].data;

  it('only looks at orders a rider has claimed and not moved', async () => {
    await service.sweep();

    const [call] = prisma.orders.findMany.mock.calls[0] as [
      {
        where: {
          status: string;
          updated_at: { lt: Date };
          assigned_rider_id: { not: null };
        };
      },
    ];
    // `accepted` and nothing else is the entire safety argument. At
    // `arrived_at_merchant` the rider is waiting on the shop; from `picked_up`
    // onward they physically hold the goods and releasing would advertise an
    // order whose food is in someone's bag.
    expect(call.where.status).toBe('accepted');
    expect(call.where.assigned_rider_id).toEqual({ not: null });
    expect(
      Date.now() - call.where.updated_at.lt.getTime(),
    ).toBeGreaterThanOrEqual(RELEASE_AFTER_MINUTES * 60_000 - 1000);
  });

  it('puts a stalled claim back on the feed, unassigned', async () => {
    prisma.orders.findMany.mockResolvedValue([stalled()]);

    const result = await service.sweep();

    const [call] = prisma.orders.updateMany.mock.calls[0] as [UpdateManyCall];
    expect(call.data).toEqual({
      assigned_rider_id: null,
      status: 'ready_for_pickup',
    });
    expect(result).toEqual({ released: 1, skipped: 0 });
  });

  // claimOrder lets a rider hold one order plus one queued behind it. The
  // queued claim waits in `accepted` while the first is delivered, so it is
  // not stalled — releasing it took "Up next" away mid-delivery.
  it('leaves a queued claim alone while its rider is out on another order', async () => {
    prisma.orders.findMany.mockResolvedValue([stalled()]);
    prisma.orders.groupBy.mockResolvedValue([{ assigned_rider_id: 'rider-1' }]);

    const result = await service.sweep();

    expect(prisma.orders.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ released: 0, skipped: 0 });
    const [busyQuery] = prisma.orders.groupBy.mock.calls[0] as [
      { where: { assigned_rider_id: { in: string[] }; OR: unknown[] } },
    ];
    expect(busyQuery.where.assigned_rider_id).toEqual({ in: ['rider-1'] });
    // Out on a live leg, or delivered within the release window.
    expect(JSON.stringify(busyQuery.where.OR)).toContain('in_transit');
    expect(JSON.stringify(busyQuery.where.OR)).toContain('delivered_at');
  });

  it('still releases a stalled claim whose rider has nothing else on', async () => {
    prisma.orders.findMany.mockResolvedValue([
      stalled(),
      stalled({ id: 'ord-2', ref_no: 'CT-1002', assigned_rider_id: 'rider-2' }),
    ]);
    prisma.orders.groupBy.mockResolvedValue([{ assigned_rider_id: 'rider-1' }]);

    const result = await service.sweep();

    expect(prisma.orders.updateMany).toHaveBeenCalledTimes(1);
    const [call] = prisma.orders.updateMany.mock.calls[0] as [
      { where: { id: string } },
    ];
    expect(call.where.id).toBe('ord-2');
    expect(result).toEqual({ released: 1, skipped: 0 });
  });

  // A rider tapping "arrived" in the same second must keep their order rather
  // than losing it mid-tap, so the status and the rider are re-checked in the
  // same statement that writes.
  it('re-checks the status and the rider in the write itself', async () => {
    prisma.orders.findMany.mockResolvedValue([stalled()]);

    await service.sweep();

    const [call] = prisma.orders.updateMany.mock.calls[0] as [UpdateManyCall];
    expect(call.where).toEqual({
      id: 'ord-1',
      status: 'accepted',
      assigned_rider_id: 'rider-1',
    });
  });

  it('counts a lost race as skipped and writes no audit row for it', async () => {
    prisma.orders.findMany.mockResolvedValue([stalled()]);
    prisma.orders.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.sweep();

    expect(prisma.order_assignment_events.create).not.toHaveBeenCalled();
    expect(prisma.push_outbox.create).not.toHaveBeenCalled();
    expect(result).toEqual({ released: 0, skipped: 1 });
  });

  // `order_assignment_events.action` carries a CHECK constraint allowing only
  // claimed / released / admin_unassigned / admin_canceled, so inventing
  // `auto_released` would throw at runtime and nowhere else.
  it('records the release with an action the CHECK constraint allows', async () => {
    prisma.orders.findMany.mockResolvedValue([stalled()]);

    await service.sweep();

    expect([
      'claimed',
      'released',
      'admin_unassigned',
      'admin_canceled',
    ]).toContain(auditRow().action);
  });

  it('attributes the release to nobody, and says why in the reason', async () => {
    prisma.orders.findMany.mockResolvedValue([stalled()]);

    await service.sweep();

    // A null actor is what distinguishes the robot from an admin who
    // unassigned by hand — including for the lap counter below.
    expect(auditRow().actor_id).toBeNull();
    expect(auditRow().rider_id).toBe('rider-1');
    expect(String(auditRow().reason)).toMatch(/auto-released/i);
  });

  it('tells the rider, who otherwise watches an order vanish', async () => {
    prisma.orders.findMany.mockResolvedValue([stalled()]);

    await service.sweep();

    const [call] = prisma.push_outbox.create.mock.calls[0] as [
      { data: { user_id: string; data: { order_id: string } } },
    ];
    expect(call.data.user_id).toBe('rider-1');
    expect(call.data.data.order_id).toBe('ord-1');
  });

  it('gives up on an order that has already been round the loop', async () => {
    prisma.orders.findMany.mockResolvedValue([stalled()]);
    prisma.order_assignment_events.groupBy.mockResolvedValue([
      { order_id: 'ord-1', _count: { _all: MAX_AUTO_RELEASES } },
    ]);

    const result = await service.sweep();

    // Otherwise it cycles claim → stall → release forever, and because each
    // lap moves `updated_at` the order stays permanently invisible to the
    // stuck sweep — the one thing that would have told a human about it.
    expect(prisma.orders.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ released: 0, skipped: 1 });
  });

  it('still acts on an order below the lap limit', async () => {
    prisma.orders.findMany.mockResolvedValue([stalled()]);
    prisma.order_assignment_events.groupBy.mockResolvedValue([
      { order_id: 'ord-1', _count: { _all: MAX_AUTO_RELEASES - 1 } },
    ]);

    const result = await service.sweep();

    expect(result).toEqual({ released: 1, skipped: 0 });
  });

  it('counts only automatic releases against the limit', async () => {
    prisma.orders.findMany.mockResolvedValue([stalled()]);

    await service.sweep();

    const [call] = prisma.order_assignment_events.groupBy.mock.calls[0] as [
      { where: { actor_id: null; action: string } },
    ];
    // An admin unassigning by hand is a decision, and it must not spend the
    // robot's budget of attempts.
    expect(call.where.actor_id).toBeNull();
  });

  it('one unreleasable order does not cost the rest of the batch its sweep', async () => {
    prisma.orders.findMany.mockResolvedValue([
      stalled({ id: 'ord-1' }),
      stalled({ id: 'ord-2' }),
    ]);
    prisma.orders.updateMany
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValue({ count: 1 });

    const result = await service.sweep();

    expect(result).toEqual({ released: 1, skipped: 1 });
  });

  it('writes nothing when no claim has stalled', async () => {
    const result = await service.sweep();

    expect(prisma.orders.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ released: 0, skipped: 0 });
  });

  it('the scheduled entry point swallows errors rather than killing the process', async () => {
    prisma.orders.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.handleCron()).resolves.toBeUndefined();
  });
});
