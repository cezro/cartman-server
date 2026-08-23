import { StuckOrderService } from './stuck-order.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * H17 — nothing times out a stuck order.
 *
 * The admin console surfaces them (I14) and `admin_unassign_order` /
 * `admin_cancel_order` exist, so a human who is looking can act. This is the
 * half that happens without a human looking. It deliberately changes no order
 * state: it only tells the customer and the admins. A robot cancelling an
 * order a merchant already cooked is a worse failure than a slow one.
 */
describe('StuckOrderService', () => {
  let prisma: {
    orders: { findMany: jest.Mock };
    profiles: { findMany: jest.Mock };
    push_outbox: { findMany: jest.Mock; createMany: jest.Mock };
  };
  let service: StuckOrderService;

  const order = (over: Record<string, unknown> = {}) => ({
    id: 'ord-1',
    ref_no: 'CT-1001',
    customer_id: 'cust-1',
    status: 'ready_for_pickup',
    updated_at: new Date(Date.now() - 20 * 60_000),
    ...over,
  });

  beforeEach(() => {
    prisma = {
      orders: { findMany: jest.fn().mockResolvedValue([]) },
      profiles: { findMany: jest.fn().mockResolvedValue([{ id: 'admin-1' }]) },
      push_outbox: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    service = new StuckOrderService(prisma as unknown as PrismaService);
  });

  interface SweepWhere {
    status: { notIn: string[] };
    OR: {
      status: { in?: string[]; notIn?: string[] };
      updated_at: { lt: Date };
    }[];
  }
  const sweepWhere = (): SweepWhere =>
    (prisma.orders.findMany.mock.calls[0] as [{ where: SweepWhere }])[0].where;

  it('only considers non-terminal orders that have gone quiet', async () => {
    await service.sweep();

    // An allow-list of "still running" would silently gain every new status
    // ever added; the terminal set is the short, stable one. (This repo has
    // already been bitten by the inverse: three guards spelled the terminal
    // set as `notIn: [delivered, canceled]`, so `delivery_failed` escaped it
    // and counted as active.)
    expect(sweepWhere().status.notIn).toEqual(
      expect.arrayContaining(['delivered', 'canceled', 'delivery_failed']),
    );
    for (const branch of sweepWhere().OR) {
      expect(branch.updated_at.lt).toBeInstanceOf(Date);
    }
  });

  // `orders_set_updated_at` fires on UPDATE, and nothing updates the row
  // during a drive — telemetry goes to `rider_locations`. So a healthy
  // 25-minute delivery is indistinguishable from an abandoned one on a single
  // clock, and the sweep used to call both stuck at 15 minutes.
  it('gives an order the rider is carrying a longer clock than one in a queue', async () => {
    await service.sweep();

    const carrying = sweepWhere().OR.find((b) =>
      b.status.in?.includes('in_transit'),
    );
    const queued = sweepWhere().OR.find((b) => b.status.notIn);

    expect(carrying).toBeDefined();
    expect(queued).toBeDefined();
    expect(carrying!.status.in).toEqual(
      expect.arrayContaining(['picked_up', 'in_transit']),
    );
    // The carrying cutoff reaches further back, so it takes longer to trip.
    expect(carrying!.updated_at.lt.getTime()).toBeLessThan(
      queued!.updated_at.lt.getTime(),
    );
    // and the queue branch must not also match a carried order, or the longer
    // clock is decorative.
    expect(queued!.status.notIn).toEqual(
      expect.arrayContaining(['picked_up', 'in_transit']),
    );
  });

  describe('the customer is told which party everyone is waiting on', () => {
    const bodyFor = async (status: string): Promise<string> => {
      prisma.orders.findMany.mockResolvedValue([order({ status })]);
      await service.sweep();
      const [{ data: rows }] = prisma.push_outbox.createMany.mock.calls[0] as [
        { data: { user_id: string; title: string; body: string }[] },
      ];
      const row = rows.find((r) => r.user_id === 'cust-1')!;
      return `${row.title} ${row.body}`;
    };

    // The bug this replaces: one sentence, "Still looking for a rider", sent
    // for every stuck order regardless of status. To someone whose rider is
    // five minutes from their door that is not just unhelpful — it is wrong in
    // the direction that causes the support call it exists to prevent.
    it('does not claim there is no rider when a rider is carrying the order', async () => {
      for (const status of ['picked_up', 'in_transit']) {
        prisma.push_outbox.createMany.mockClear();
        expect(await bodyFor(status)).not.toMatch(/looking for a rider/i);
      }
    });

    it('does not claim there is no rider when one is already assigned', async () => {
      for (const status of ['accepted', 'arrived_at_merchant']) {
        prisma.push_outbox.createMany.mockClear();
        expect(await bodyFor(status)).not.toMatch(/looking for a rider/i);
      }
    });

    it('still says exactly that when the order really is waiting for a rider', async () => {
      expect(await bodyFor('ready_for_pickup')).toMatch(/looking for a rider/i);
    });

    it('blames the store, not the rider, before the store has confirmed', async () => {
      expect(await bodyFor('pending')).toMatch(/store/i);
    });
  });

  it('tells the admin how long it has really been quiet, not the threshold', async () => {
    prisma.orders.findMany.mockResolvedValue([
      order({
        status: 'preparing',
        updated_at: new Date(Date.now() - 120 * 60_000),
      }),
    ]);

    await service.sweep();

    const [{ data: rows }] = prisma.push_outbox.createMany.mock.calls[0] as [
      { data: { user_id: string; body: string }[] },
    ];
    const admin = rows.find((r) => r.user_id === 'admin-1')!;
    // "has not moved in 15 minutes" on an order that has been quiet for two
    // hours reads as a fresh problem and buries the older one.
    expect(admin.body).toMatch(/120 minutes/);
    expect(admin.body).toMatch(/preparing/);
  });

  it('tells the customer and every admin that an order is stuck', async () => {
    prisma.orders.findMany.mockResolvedValue([order()]);
    prisma.profiles.findMany.mockResolvedValue([
      { id: 'admin-1' },
      { id: 'admin-2' },
    ]);

    const result = await service.sweep();

    const [{ data: rows }] = prisma.push_outbox.createMany.mock.calls[0] as [
      { data: { user_id: string; event: string }[] },
    ];
    expect(rows.map((r) => r.user_id).sort()).toEqual([
      'admin-1',
      'admin-2',
      'cust-1',
    ]);
    // The customer's copy must not read like the admin's: one is an apology,
    // the other is a work item.
    expect(rows.find((r) => r.user_id === 'cust-1')?.event).toBe('order.stuck');
    expect(rows.find((r) => r.user_id === 'admin-1')?.event).toBe(
      'order.stuck.admin',
    );
    expect(result).toEqual({ stuck: 1, notified: 3 });
  });

  it('does not notify the same order twice', async () => {
    prisma.orders.findMany.mockResolvedValue([
      order({ id: 'ord-1' }),
      order({ id: 'ord-2' }),
    ]);
    // ord-1 was already reported on an earlier pass.
    prisma.push_outbox.findMany.mockResolvedValue([
      { data: { order_id: 'ord-1' } },
    ]);

    const result = await service.sweep();

    // The sweep runs every few minutes and a stuck order stays stuck, so
    // without this the customer is told the same bad news on a loop — which
    // is worse than not being told at all.
    const [{ data: rows }] = prisma.push_outbox.createMany.mock.calls[0] as [
      { data: { data: { order_id: string } }[] },
    ];
    expect(rows.every((r) => r.data.order_id === 'ord-2')).toBe(true);
    expect(result).toEqual({ stuck: 1, notified: 2 });
  });

  it('writes nothing when nothing is stuck', async () => {
    const result = await service.sweep();

    expect(prisma.push_outbox.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ stuck: 0, notified: 0 });
  });

  it('still tells the customer when there are no admins', async () => {
    prisma.orders.findMany.mockResolvedValue([order()]);
    prisma.profiles.findMany.mockResolvedValue([]);

    const result = await service.sweep();

    // No account in production currently holds role='admin'. The customer
    // being told is the half that stops a support call, and it must not
    // depend on the half that is only an ops convenience.
    expect(result).toEqual({ stuck: 1, notified: 1 });
  });

  it('the scheduled entry point swallows errors rather than killing the process', async () => {
    prisma.orders.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.handleCron()).resolves.toBeUndefined();
  });
});
