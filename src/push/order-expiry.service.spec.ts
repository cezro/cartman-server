import { order_status } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  EXPIRE_AFTER_HOURS,
  EXPIRY_CANCELED_BY,
  OrderExpiryService,
} from './order-expiry.service';

interface UpdateManyCall {
  where: {
    status: order_status;
    assigned_rider_id: null;
    created_at: { lt: Date };
  };
  data: { status: order_status; canceled_by: string; canceled_reason: string };
}

describe('OrderExpiryService', () => {
  let prisma: { orders: { updateMany: jest.Mock } };
  let service: OrderExpiryService;

  beforeEach(() => {
    prisma = {
      orders: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    service = new OrderExpiryService(prisma as unknown as PrismaService);
  });

  const calls = () =>
    prisma.orders.updateMany.mock.calls.map((c) => c[0] as UpdateManyCall);

  it('expires after eight hours', () => {
    expect(EXPIRE_AFTER_HOURS).toBe(8);
  });

  it('cancels unclaimed pending, preparing and ready orders older than the window', async () => {
    await service.sweep();

    expect(calls().map((c) => c.where.status)).toEqual([
      order_status.pending,
      order_status.preparing,
      order_status.ready_for_pickup,
    ]);
    for (const call of calls()) {
      // Never under a rider: a held order is moving, or the stall sweep and
      // the stuck notices own it.
      expect(call.where.assigned_rider_id).toBeNull();
      const age = Date.now() - call.where.created_at.lt.getTime();
      expect(age).toBeGreaterThanOrEqual(8 * 60 * 60_000 - 1000);
      expect(age).toBeLessThanOrEqual(8 * 60 * 60_000 + 1000);
      expect(call.data.status).toBe(order_status.canceled);
      expect(call.data.canceled_by).toBe(EXPIRY_CANCELED_BY);
    }
  });

  it('tells the customer whose step never happened', async () => {
    await service.sweep();

    const reasons = calls().map((c) => c.data.canceled_reason);
    expect(reasons[0]).toContain('store did not confirm');
    expect(reasons[2]).toBe('No rider was available within 8 hours.');
  });

  it('never touches an order once it is picked up or later', async () => {
    await service.sweep();

    const touched = calls().map((c) => c.where.status);
    for (const live of [
      order_status.accepted,
      order_status.arrived_at_merchant,
      order_status.picked_up,
      order_status.in_transit,
    ]) {
      expect(touched).not.toContain(live);
    }
  });

  it('reports how many it expired', async () => {
    prisma.orders.updateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 3 });

    expect(await service.sweep()).toEqual({ expired: 5 });
  });
});
