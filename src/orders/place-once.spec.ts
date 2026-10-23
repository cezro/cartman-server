import { Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';

// cust-checkout-15: a placement whose response was lost reads as a failure on
// the phone, and the retry used to create a second COD order.
describe('OrdersService.placeOnce', () => {
  let prisma: { orders: { findFirst: jest.Mock } };
  let service: OrdersService;
  const KEY = '7d0f8a64-1c2b-4c3d-9e8f-0a1b2c3d4e5f';
  const existing = {
    id: 'order-1',
    ref_no: 'CMN-000001',
    order_items: [],
    order_stops: [],
  };

  beforeEach(() => {
    prisma = { orders: { findFirst: jest.fn().mockResolvedValue(null) } };
    service = new OrdersService(
      prisma as unknown as PrismaService,
      {} as LedgerService,
    );
  });

  it('places as before when the app sends no key (older builds)', async () => {
    const place = jest.fn().mockResolvedValue({ id: 'new' });

    expect(await service.placeOnce('cust-1', undefined, place)).toEqual({
      id: 'new',
    });
    expect(place).toHaveBeenCalledTimes(1);
    expect(prisma.orders.findFirst).not.toHaveBeenCalled();
  });

  it('returns the order a repeated key already created, without placing again', async () => {
    prisma.orders.findFirst.mockResolvedValue(existing);
    const place = jest.fn();

    const result = (await service.placeOnce('cust-1', KEY, place)) as {
      id: string;
    };

    expect(result.id).toBe('order-1');
    expect(place).not.toHaveBeenCalled();
    // Scoped to the caller: another customer's key never matches.
    expect(prisma.orders.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customer_id: 'cust-1', client_order_id: KEY },
      }),
    );
  });

  it('places once for a new key', async () => {
    const place = jest.fn().mockResolvedValue({ id: 'new' });

    expect(await service.placeOnce('cust-1', KEY, place)).toEqual({
      id: 'new',
    });
    expect(place).toHaveBeenCalledTimes(1);
  });

  it('returns the winner when two identical requests race (unique violation)', async () => {
    prisma.orders.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing);
    const place = jest.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const result = (await service.placeOnce('cust-1', KEY, place)) as {
      id: string;
    };

    expect(result.id).toBe('order-1');
  });

  it('rethrows every other failure (a closed store is still a 409)', async () => {
    const place = jest.fn().mockRejectedValue(new Error('closed'));

    await expect(service.placeOnce('cust-1', KEY, place)).rejects.toThrow(
      'closed',
    );
  });
});
