import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { order_status } from '@prisma/client';

describe('OrdersService', () => {
  let service: OrdersService;
  let prisma: {
    merchants: { findUnique: jest.Mock };
    menu_items: { findUnique: jest.Mock };
    orders: {
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
    riders: { findUnique: jest.Mock };
    rider_wallet_transactions: { findFirst: jest.Mock; create: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
  };
  let ledgerService: {
    getNetCash: jest.Mock;
    createManualTransaction: jest.Mock;
  };

  // Sequence counter for the mocked `select nextval('order_ref_seq')` query.
  let nextvalCounter: bigint;

  beforeEach(() => {
    nextvalCounter = 0n;

    prisma = {
      merchants: { findUnique: jest.fn() },
      menu_items: { findUnique: jest.fn() },
      orders: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      riders: { findUnique: jest.fn() },
      rider_wallet_transactions: { findFirst: jest.fn(), create: jest.fn() },
      $queryRaw: jest.fn().mockImplementation(() => {
        nextvalCounter += 1n;
        return Promise.resolve([{ nextval: nextvalCounter }]);
      }),
      $transaction: jest.fn(),
    };

    // Default: $transaction just invokes the callback with `prisma` itself
    // acting as the `tx` client (same mocked tables/fns are reused).
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      Promise.resolve(cb(prisma)),
    );

    ledgerService = {
      getNetCash: jest.fn().mockResolvedValue(0n),
      createManualTransaction: jest.fn().mockResolvedValue({}),
    };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      ledgerService as unknown as LedgerService,
    );
  });

  describe('2.1 — non-merchant orders are born ready_for_pickup', () => {
    it('placeErrandOrder creates with status ready_for_pickup', async () => {
      prisma.orders.create.mockResolvedValue({
        id: 'order-1',
        status: order_status.ready_for_pickup,
      });

      await service.placeErrandOrder('cust-1', {
        errand_payload: {},
        notes: '',
      });

      expect(prisma.orders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: order_status.ready_for_pickup,
          }) as Record<string, unknown>,
        }),
      );
    });

    it('placeCourierOrder creates with status ready_for_pickup', async () => {
      prisma.orders.create.mockResolvedValue({
        id: 'order-2',
        status: order_status.ready_for_pickup,
      });

      await service.placeCourierOrder('cust-1', {
        pickup_lat: 10,
        pickup_lng: 122,
        dropoff_lat: 10.1,
        dropoff_lng: 122.1,
      });

      expect(prisma.orders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: order_status.ready_for_pickup,
          }) as Record<string, unknown>,
        }),
      );
    });

    it('placeRideOrder creates with status ready_for_pickup', async () => {
      prisma.orders.create.mockResolvedValue({
        id: 'order-3',
        status: order_status.ready_for_pickup,
      });

      await service.placeRideOrder('cust-1', {
        pickup_lat: 10,
        pickup_lng: 122,
        dropoff_lat: 10.1,
        dropoff_lng: 122.1,
      });

      expect(prisma.orders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: order_status.ready_for_pickup,
          }) as Record<string, unknown>,
        }),
      );
    });

    it('placeFoodOrder / placeGroceryOrder still create as pending (merchant prep required)', async () => {
      prisma.merchants.findUnique.mockResolvedValue({
        id: 'merchant-1',
        name: 'Merchant',
        delivery_fee: 3000n,
      });
      prisma.menu_items.findUnique.mockResolvedValue({
        id: 'item-1',
        merchant_id: 'merchant-1',
        name: 'Burger',
        price: 5000n,
        in_stock: true,
      });
      prisma.orders.create.mockResolvedValue({
        id: 'order-4',
        status: order_status.pending,
        order_items: [],
      });

      await service.placeFoodOrder('cust-1', {
        merchant_id: 'merchant-1',
        items: [{ menu_item_id: 'item-1', qty: 1 }],
      });

      expect(prisma.orders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: order_status.pending,
          }) as Record<string, unknown>,
        }),
      );
    });
  });

  describe('a fresh errand order is claimable', () => {
    it('claimOrder succeeds when the order is ready_for_pickup and unassigned', async () => {
      prisma.riders.findUnique.mockResolvedValue({
        id: 'rider-1',
        is_active: true,
      });
      ledgerService.getNetCash.mockResolvedValue(0n);
      prisma.orders.updateMany.mockResolvedValue({ count: 1 });
      prisma.orders.findUnique.mockResolvedValue({
        id: 'order-1',
        status: order_status.accepted,
        assigned_rider_id: 'rider-1',
      });

      const result = await service.claimOrder('order-1', 'rider-1');

      expect(prisma.orders.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: order_status.ready_for_pickup,
          }) as Record<string, unknown>,
        }),
      );
      expect(result.status).toBe(order_status.accepted);
    });
  });

  describe('2.2 — advanceRiderStatus transition guard', () => {
    it('rejects an illegal jump (accepted -> delivered)', async () => {
      prisma.orders.findUnique.mockResolvedValue({
        id: 'order-1',
        status: order_status.accepted,
        assigned_rider_id: 'rider-1',
      });

      await expect(
        service.advanceRiderStatus(
          'order-1',
          'rider-1',
          order_status.delivered,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.advanceRiderStatus(
          'order-1',
          'rider-1',
          order_status.delivered,
        ),
      ).rejects.toThrow('Illegal status transition');

      expect(prisma.orders.update).not.toHaveBeenCalled();
    });

    it('accepts a legal single-step transition (accepted -> arrived_at_merchant)', async () => {
      prisma.orders.findUnique.mockResolvedValue({
        id: 'order-1',
        status: order_status.accepted,
        assigned_rider_id: 'rider-1',
      });
      prisma.orders.update.mockResolvedValue({
        id: 'order-1',
        status: order_status.arrived_at_merchant,
        assigned_rider_id: 'rider-1',
      });

      const result = await service.advanceRiderStatus(
        'order-1',
        'rider-1',
        order_status.arrived_at_merchant,
      );

      expect(result.status).toBe(order_status.arrived_at_merchant);
    });

    it('throws NotFound/BadRequest when the order does not exist or is not assigned to this rider', async () => {
      prisma.orders.findUnique.mockResolvedValue(null);

      await expect(
        service.advanceRiderStatus(
          'order-missing',
          'rider-1',
          order_status.picked_up,
        ),
      ).rejects.toThrow();
    });

    describe('idempotent delivered branch', () => {
      it('writes ledger rows once on first delivered call', async () => {
        prisma.orders.findUnique.mockResolvedValue({
          id: 'order-1',
          status: order_status.in_transit,
          assigned_rider_id: 'rider-1',
          delivery_payout: 5000n,
          total: 5000n,
          payment: 'cod',
        });
        prisma.rider_wallet_transactions.findFirst.mockResolvedValue(null);
        prisma.orders.update.mockResolvedValue({
          id: 'order-1',
          status: order_status.delivered,
          assigned_rider_id: 'rider-1',
          delivery_payout: 5000n,
          total: 5000n,
          payment: 'cod',
        });
        prisma.rider_wallet_transactions.create.mockResolvedValue({});

        await service.advanceRiderStatus(
          'order-1',
          'rider-1',
          order_status.delivered,
        );

        expect(prisma.rider_wallet_transactions.create).toHaveBeenCalledTimes(
          2,
        );
      });

      it('does not double-write ledger rows on a second delivered call for the same order', async () => {
        prisma.orders.findUnique.mockResolvedValue({
          id: 'order-1',
          status: order_status.delivered,
          assigned_rider_id: 'rider-1',
          delivery_payout: 5000n,
          total: 5000n,
          payment: 'cod',
        });
        // A credit_delivery_reward row for this order already exists.
        prisma.rider_wallet_transactions.findFirst.mockResolvedValue({
          id: 1n,
          order_id: 'order-1',
          type: 'credit_delivery_reward',
        });

        // Second call with the same target status is not a legal transition
        // from `delivered` (terminal state) — NEXT[delivered] is undefined,
        // so this is rejected as an illegal transition. This is the one
        // deterministic behavior asserted here: repeating `delivered` fails
        // fast via the transition guard, before the ledger is ever touched.
        await expect(
          service.advanceRiderStatus(
            'order-1',
            'rider-1',
            order_status.delivered,
          ),
        ).rejects.toThrow(BadRequestException);

        expect(prisma.rider_wallet_transactions.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('2.4 — ref_no generation', () => {
    it('sets ref_no in format CMN-XXXXXX on placeErrandOrder', async () => {
      prisma.orders.create.mockImplementation(
        (args: { data: { ref_no?: string } }) =>
          Promise.resolve({ id: 'order-1', ...args.data }),
      );

      const result = await service.placeErrandOrder('cust-1', {
        errand_payload: {},
        notes: '',
      });

      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(result.ref_no).toMatch(/^CMN-\d{6}$/);
    });

    it('sets ref_no in format CMN-XXXXXX on placeFoodOrder', async () => {
      prisma.merchants.findUnique.mockResolvedValue({
        id: 'merchant-1',
        name: 'Merchant',
        delivery_fee: 3000n,
      });
      prisma.menu_items.findUnique.mockResolvedValue({
        id: 'item-1',
        merchant_id: 'merchant-1',
        name: 'Burger',
        price: 5000n,
        in_stock: true,
      });
      prisma.orders.create.mockImplementation(
        (args: { data: { ref_no?: string } }) =>
          Promise.resolve({ id: 'order-4', ...args.data, order_items: [] }),
      );

      const result = await service.placeFoodOrder('cust-1', {
        merchant_id: 'merchant-1',
        items: [{ menu_item_id: 'item-1', qty: 1 }],
      });

      expect(result.ref_no).toMatch(/^CMN-\d{6}$/);
    });
  });

  describe('2.5 — customer cancel', () => {
    it('succeeds while the order is unassigned and pending/ready_for_pickup', async () => {
      prisma.orders.updateMany.mockResolvedValue({ count: 1 });
      prisma.orders.findUnique.mockResolvedValue({
        id: 'order-1',
        status: order_status.canceled,
      });

      const result = await service.cancelOrder('order-1', 'cust-1');

      expect(prisma.orders.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'order-1',
            customer_id: 'cust-1',
            assigned_rider_id: null,
            status: {
              in: [order_status.pending, order_status.ready_for_pickup],
            },
          }) as Record<string, unknown>,
          data: { status: order_status.canceled },
        }),
      );
      expect(result.status).toBe(order_status.canceled);
    });

    it('is rejected once a rider has been assigned (updateMany count 0)', async () => {
      prisma.orders.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.cancelOrder('order-1', 'cust-1')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.cancelOrder('order-1', 'cust-1')).rejects.toThrow(
        'Order can no longer be cancelled',
      );
    });
  });
});
