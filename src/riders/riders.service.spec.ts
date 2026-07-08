import { RidersService } from './riders.service';
import { PrismaService } from '../prisma/prisma.service';

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
