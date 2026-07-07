import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { AdminOrdersQueryDto } from './dto/admin.dto';

describe('AdminService.getOrders', () => {
  let service: AdminService;
  let prisma: {
    orders: { findMany: jest.Mock; count: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      orders: { findMany: jest.fn(), count: jest.fn() },
    };
    service = new AdminService(
      prisma as unknown as PrismaService,
      {} as LedgerService,
    );
  });

  it('returns the pagination envelope with items, total, limit, offset', async () => {
    prisma.orders.findMany.mockResolvedValue([
      { id: 'o1', total: 10000n, subtotal: 9000n, delivery_fee: 1000n, discount: 0n, delivery_payout: 1000n, customer: { id: 'c1', full_name: 'Juan', phone: '+639171234567' }, rider: null },
    ]);
    prisma.orders.count.mockResolvedValue(1);

    const query = Object.assign(new AdminOrdersQueryDto(), { limit: 20, offset: 0 });
    const result = await service.getOrders(query);

    expect(result.total).toBe(1);
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
    expect(result.items).toHaveLength(1);
  });

  it('converts BigInt money fields to Number in each item', async () => {
    prisma.orders.findMany.mockResolvedValue([
      { id: 'o1', total: 10000n, subtotal: 9000n, delivery_fee: 1000n, discount: 0n, delivery_payout: 1000n, customer: { id: 'c1', full_name: 'Juan', phone: '+639171234567' }, rider: null },
    ]);
    prisma.orders.count.mockResolvedValue(1);

    const query = Object.assign(new AdminOrdersQueryDto(), { limit: 20, offset: 0 });
    const result = await service.getOrders(query);

    expect(result.items[0].total).toBe(10000);
    expect(typeof result.items[0].total).toBe('number');
  });

  it('maps a CSV status filter to a status:{in} where clause', async () => {
    prisma.orders.findMany.mockResolvedValue([]);
    prisma.orders.count.mockResolvedValue(0);

    const query = Object.assign(new AdminOrdersQueryDto(), {
      limit: 20,
      offset: 0,
      status: ['pending', 'ready_for_pickup'],
    });
    await service.getOrders(query);

    const call = prisma.orders.findMany.mock.calls[0][0];
    expect(call.where.status).toEqual({ in: ['pending', 'ready_for_pickup'] });
  });

  it('applies type/rider_id/customer_id/merchant_id filters', async () => {
    prisma.orders.findMany.mockResolvedValue([]);
    prisma.orders.count.mockResolvedValue(0);

    const query = Object.assign(new AdminOrdersQueryDto(), {
      limit: 20,
      offset: 0,
      type: 'food',
      rider_id: 'r1',
      customer_id: 'c1',
      merchant_id: 'm1',
    });
    await service.getOrders(query);

    const call = prisma.orders.findMany.mock.calls[0][0];
    expect(call.where.type).toBe('food');
    expect(call.where.assigned_rider_id).toBe('r1');
    expect(call.where.customer_id).toBe('c1');
    expect(call.where.merchant_id).toBe('m1');
  });

  it('applies limit/offset as take/skip and orders by created_at desc', async () => {
    prisma.orders.findMany.mockResolvedValue([]);
    prisma.orders.count.mockResolvedValue(0);

    const query = Object.assign(new AdminOrdersQueryDto(), {
      limit: 5,
      offset: 15,
    });
    await service.getOrders(query);

    const call = prisma.orders.findMany.mock.calls[0][0];
    expect(call.take).toBe(5);
    expect(call.skip).toBe(15);
    expect(call.orderBy).toEqual({ created_at: 'desc' });
  });
});

describe('AdminService.getOrderById', () => {
  let service: AdminService;
  let prisma: {
    orders: { findUnique: jest.Mock };
    riders: { findUnique: jest.Mock };
    rider_locations: { findFirst: jest.Mock };
    rider_wallet_transactions: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      orders: { findUnique: jest.fn() },
      riders: { findUnique: jest.fn() },
      rider_locations: { findFirst: jest.fn() },
      rider_wallet_transactions: { findMany: jest.fn() },
    };
    service = new AdminService(
      prisma as unknown as PrismaService,
      {} as LedgerService,
    );
  });

  it('throws NotFoundException when the order does not exist', async () => {
    prisma.orders.findUnique.mockResolvedValue(null);

    await expect(service.getOrderById('missing-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns ledger_entries with string id/amount', async () => {
    prisma.orders.findUnique.mockResolvedValue({
      id: 'o1',
      assigned_rider_id: null,
      total: 10000n,
      subtotal: 9000n,
      delivery_fee: 1000n,
      discount: 0n,
      delivery_payout: 1000n,
      order_items: [],
      order_stops: [],
      customer: { id: 'c1', full_name: 'Juan', phone: '+639171234567' },
      rider: null,
    });
    prisma.rider_wallet_transactions.findMany.mockResolvedValue([
      {
        id: 42n,
        type: 'credit_delivery_reward',
        amount: 5000n,
        created_at: new Date('2026-07-05T00:00:00.000Z'),
      },
    ]);

    const result = await service.getOrderById('o1');

    expect(result.ledger_entries).toEqual([
      {
        id: '42',
        type: 'credit_delivery_reward',
        amount: '5000',
        created_at: new Date('2026-07-05T00:00:00.000Z'),
      },
    ]);
  });

  it('attaches last_location and rider vehicle/plate_no/rating when a rider is assigned', async () => {
    prisma.orders.findUnique.mockResolvedValue({
      id: 'o1',
      assigned_rider_id: 'rider-1',
      total: 10000n,
      subtotal: 9000n,
      delivery_fee: 1000n,
      discount: 0n,
      delivery_payout: 1000n,
      order_items: [],
      order_stops: [],
      customer: { id: 'c1', full_name: 'Juan', phone: '+639171234567' },
      rider: { id: 'rider-1', full_name: 'Pedro', phone: '+639170000000' },
    });
    prisma.riders.findUnique.mockResolvedValue({
      id: 'rider-1',
      vehicle: 'Motorcycle',
      plate_no: 'ABC-123',
      rating: { toString: () => '4.8' } as any,
    });
    prisma.rider_locations.findFirst.mockResolvedValue({
      lat: 10.5,
      lng: 123.5,
      recorded_at: new Date('2026-07-05T01:00:00.000Z'),
    });
    prisma.rider_wallet_transactions.findMany.mockResolvedValue([]);

    const result = await service.getOrderById('o1');

    expect(result.rider).toMatchObject({
      id: 'rider-1',
      full_name: 'Pedro',
      vehicle: 'Motorcycle',
      plate_no: 'ABC-123',
      rating: 4.8,
    });
    expect(result.last_location).toEqual({
      lat: 10.5,
      lng: 123.5,
      recorded_at: new Date('2026-07-05T01:00:00.000Z'),
    });
  });

  it('returns last_location: null when no rider is assigned', async () => {
    prisma.orders.findUnique.mockResolvedValue({
      id: 'o1',
      assigned_rider_id: null,
      total: 10000n,
      subtotal: 9000n,
      delivery_fee: 1000n,
      discount: 0n,
      delivery_payout: 1000n,
      order_items: [],
      order_stops: [],
      customer: { id: 'c1', full_name: 'Juan', phone: '+639171234567' },
      rider: null,
    });
    prisma.rider_wallet_transactions.findMany.mockResolvedValue([]);

    const result = await service.getOrderById('o1');

    expect(result.last_location).toBeNull();
    expect(result.rider).toBeNull();
    expect(prisma.riders.findUnique).not.toHaveBeenCalled();
  });
});
