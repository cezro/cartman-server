import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { order_status, order_type } from '@prisma/client';

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
      count: jest.Mock;
    };
    riders: { findUnique: jest.Mock };
    rider_wallet_transactions: { findFirst: jest.Mock; create: jest.Mock };
    merchant_users: { findFirst: jest.Mock };
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
        count: jest.fn().mockResolvedValue(0),
      },
      riders: { findUnique: jest.fn() },
      rider_wallet_transactions: { findFirst: jest.fn(), create: jest.fn() },
      merchant_users: { findFirst: jest.fn() },
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

  describe('3.4 — claim queue-depth guard (max 1 active + 1 queued)', () => {
    beforeEach(() => {
      prisma.riders.findUnique.mockResolvedValue({
        id: 'rider-1',
        is_active: true,
      });
      ledgerService.getNetCash.mockResolvedValue(0n);
      prisma.orders.updateMany.mockResolvedValue({ count: 1 });
      prisma.orders.findUnique.mockResolvedValue({
        id: 'order-3',
        status: order_status.accepted,
        assigned_rider_id: 'rider-1',
      });
    });

    it('rejects a third concurrent claim with "Finish your current orders first"', async () => {
      prisma.orders.count.mockResolvedValue(2);

      await expect(service.claimOrder('order-3', 'rider-1')).rejects.toThrow(
        'Finish your current orders first',
      );
      expect(prisma.orders.updateMany).not.toHaveBeenCalled();
    });

    it('returns queued: false on the first claim (rider had 0 active orders)', async () => {
      prisma.orders.count.mockResolvedValue(0);

      const result = await service.claimOrder('order-1', 'rider-1');

      expect(result.queued).toBe(false);
    });

    it('returns queued: true on the second claim (rider already had 1 active order)', async () => {
      prisma.orders.count.mockResolvedValue(1);

      const result = await service.claimOrder('order-2', 'rider-1');

      expect(result.queued).toBe(true);
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

      it('COD delivery writes exactly a credit_delivery_reward for the payout and a debit_cod_order for the total (E)', async () => {
        // delivery_payout (rider's cut) deliberately differs from total (full
        // order value the rider collected in cash) so the assertions below
        // can't pass by amounts coincidentally matching.
        prisma.orders.findUnique.mockResolvedValue({
          id: 'order-2',
          status: order_status.in_transit,
          assigned_rider_id: 'rider-1',
          delivery_payout: 4900n,
          total: 15000n,
          payment: 'cod',
        });
        prisma.rider_wallet_transactions.findFirst.mockResolvedValue(null);
        prisma.orders.update.mockResolvedValue({
          id: 'order-2',
          status: order_status.delivered,
          assigned_rider_id: 'rider-1',
          delivery_payout: 4900n,
          total: 15000n,
          payment: 'cod',
        });
        prisma.rider_wallet_transactions.create.mockResolvedValue({});

        await service.advanceRiderStatus(
          'order-2',
          'rider-1',
          order_status.delivered,
        );

        expect(prisma.rider_wallet_transactions.create).toHaveBeenCalledTimes(
          2,
        );
        expect(prisma.rider_wallet_transactions.create).toHaveBeenCalledWith({
          data: {
            rider_id: 'rider-1',
            type: 'credit_delivery_reward',
            amount: 4900n,
            order_id: 'order-2',
          },
        });
        expect(prisma.rider_wallet_transactions.create).toHaveBeenCalledWith({
          data: {
            rider_id: 'rider-1',
            type: 'debit_cod_order',
            amount: 15000n,
            order_id: 'order-2',
          },
        });

        // Every write is positive-amount, append-only — sign comes from
        // `type`, never from a negative amount (global money constraint).
        expect(
          prisma.rider_wallet_transactions.create.mock.calls.every(
            (c: unknown[]) =>
              (c[0] as { data: { amount: bigint } }).data.amount > 0n,
          ),
        ).toBe(true);
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

  describe('2.3 — customer order history', () => {
    it('includes order_items so the client can render line items without extra requests', async () => {
      prisma.orders.findMany.mockResolvedValue([
        {
          id: 'order-1',
          status: order_status.pending,
          order_items: [{ id: 1, name: 'Burger', qty: 2, unit_price: 15000n }],
        },
      ]);

      const result = await service.getHistory('cust-1');

      expect(prisma.orders.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { customer_id: 'cust-1' },
          include: expect.objectContaining({
            order_items: true,
          }) as Record<string, unknown>,
        }),
      );
      expect(result[0].order_items[0].unit_price).toBe(15000);
    });
  });

  describe('2.5 / §4 — customer cancel attribution', () => {
    const ownedOrder = {
      id: 'order-1',
      customer_id: 'cust-1',
      status: order_status.pending,
      assigned_rider_id: null,
    };

    it('succeeds while unassigned and pending/ready_for_pickup, stamping canceled_by=customer', async () => {
      prisma.orders.findUnique.mockResolvedValue({
        ...ownedOrder,
        status: order_status.canceled,
      });
      prisma.orders.updateMany.mockResolvedValue({ count: 1 });

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
          data: {
            status: order_status.canceled,
            canceled_by: 'customer',
            canceled_reason: null,
          },
        }),
      );
      expect(result.status).toBe(order_status.canceled);
    });

    it('records a trimmed cancellation reason when the body carries one', async () => {
      prisma.orders.findUnique.mockResolvedValue(ownedOrder);
      prisma.orders.updateMany.mockResolvedValue({ count: 1 });

      await service.cancelOrder('order-1', 'cust-1', '  changed my mind  ');

      expect(prisma.orders.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            canceled_reason: 'changed my mind',
          }) as Record<string, unknown>,
        }),
      );
    });

    it('stores a whitespace-only reason as null', async () => {
      prisma.orders.findUnique.mockResolvedValue(ownedOrder);
      prisma.orders.updateMany.mockResolvedValue({ count: 1 });

      await service.cancelOrder('order-1', 'cust-1', '   ');

      expect(prisma.orders.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            canceled_reason: null,
          }) as Record<string, unknown>,
        }),
      );
    });

    it('404s when the order does not exist', async () => {
      prisma.orders.findUnique.mockResolvedValue(null);

      await expect(service.cancelOrder('order-x', 'cust-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.orders.updateMany).not.toHaveBeenCalled();
    });

    it("404s when the order belongs to another customer (doesn't leak existence)", async () => {
      prisma.orders.findUnique.mockResolvedValue({
        ...ownedOrder,
        customer_id: 'someone-else',
      });

      await expect(service.cancelOrder('order-1', 'cust-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.orders.updateMany).not.toHaveBeenCalled();
    });

    it('409s once a rider has been assigned (updateMany count 0)', async () => {
      prisma.orders.findUnique.mockResolvedValue({
        ...ownedOrder,
        assigned_rider_id: 'rider-1',
        status: order_status.accepted,
      });
      prisma.orders.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.cancelOrder('order-1', 'cust-1')).rejects.toThrow(
        ConflictException,
      );
      await expect(service.cancelOrder('order-1', 'cust-1')).rejects.toThrow(
        'Order can no longer be cancelled',
      );
    });
  });

  describe('§3 — merchant accept/ready membership guard', () => {
    const merchantActor = { id: 'user-1', role: 'merchant' };
    const adminActor = { id: 'admin-1', role: 'admin' };

    const pendingOrder = {
      id: 'order-1',
      status: order_status.pending,
      merchant_id: 'merchant-1',
    };

    it('merchantAccept 403s a merchant who is not a member of the order store', async () => {
      prisma.orders.findUnique.mockResolvedValue(pendingOrder);
      prisma.merchant_users.findFirst.mockResolvedValue(null);

      await expect(
        service.merchantAccept('order-1', merchantActor),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.orders.update).not.toHaveBeenCalled();
    });

    it('merchantAccept moves pending -> preparing for a store member', async () => {
      prisma.orders.findUnique.mockResolvedValue(pendingOrder);
      prisma.merchant_users.findFirst.mockResolvedValue({
        merchant_id: 'merchant-1',
        user_id: 'user-1',
      });
      prisma.orders.update.mockResolvedValue({
        ...pendingOrder,
        status: order_status.preparing,
      });

      const result = await service.merchantAccept('order-1', merchantActor);

      expect(prisma.merchant_users.findFirst).toHaveBeenCalledWith({
        where: { user_id: 'user-1', merchant_id: 'merchant-1' },
      });
      expect(prisma.orders.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'order-1' },
          data: { status: order_status.preparing },
        }),
      );
      expect(result.status).toBe(order_status.preparing);
    });

    it('merchantAccept lets an admin act without a membership row', async () => {
      prisma.orders.findUnique.mockResolvedValue(pendingOrder);
      prisma.orders.update.mockResolvedValue({
        ...pendingOrder,
        status: order_status.preparing,
      });

      await service.merchantAccept('order-1', adminActor);

      expect(prisma.merchant_users.findFirst).not.toHaveBeenCalled();
      expect(prisma.orders.update).toHaveBeenCalled();
    });

    it('merchantAccept 409s when the order is not pending', async () => {
      prisma.orders.findUnique.mockResolvedValue({
        ...pendingOrder,
        status: order_status.canceled,
      });
      prisma.merchant_users.findFirst.mockResolvedValue({
        merchant_id: 'merchant-1',
        user_id: 'user-1',
      });

      await expect(
        service.merchantAccept('order-1', merchantActor),
      ).rejects.toThrow(ConflictException);
      expect(prisma.orders.update).not.toHaveBeenCalled();
    });

    it('merchantAccept 404s when the order does not exist', async () => {
      prisma.orders.findUnique.mockResolvedValue(null);

      await expect(
        service.merchantAccept('order-missing', merchantActor),
      ).rejects.toThrow(NotFoundException);
    });

    it('merchantAccept 403s a merchant on an order with no merchant (errand)', async () => {
      prisma.orders.findUnique.mockResolvedValue({
        id: 'order-2',
        status: order_status.pending,
        merchant_id: null,
      });

      await expect(
        service.merchantAccept('order-2', merchantActor),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.merchant_users.findFirst).not.toHaveBeenCalled();
    });

    it('merchantMarkReady moves preparing -> ready_for_pickup for a store member', async () => {
      prisma.orders.findUnique.mockResolvedValue({
        ...pendingOrder,
        status: order_status.preparing,
      });
      prisma.merchant_users.findFirst.mockResolvedValue({
        merchant_id: 'merchant-1',
        user_id: 'user-1',
      });
      prisma.orders.update.mockResolvedValue({
        ...pendingOrder,
        status: order_status.ready_for_pickup,
      });

      const result = await service.merchantMarkReady('order-1', merchantActor);

      expect(prisma.orders.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'order-1' },
          data: { status: order_status.ready_for_pickup },
        }),
      );
      expect(result.status).toBe(order_status.ready_for_pickup);
    });

    it('merchantMarkReady 409s when the order is still pending (accept first)', async () => {
      prisma.orders.findUnique.mockResolvedValue(pendingOrder);
      prisma.merchant_users.findFirst.mockResolvedValue({
        merchant_id: 'merchant-1',
        user_id: 'user-1',
      });

      await expect(
        service.merchantMarkReady('order-1', merchantActor),
      ).rejects.toThrow(ConflictException);
      expect(prisma.orders.update).not.toHaveBeenCalled();
    });
  });

  describe('§2 — merchant reject', () => {
    const merchantActor = { id: 'user-1', role: 'merchant' };
    const membership = { merchant_id: 'merchant-1', user_id: 'user-1' };

    const pendingOrder = {
      id: 'order-1',
      status: order_status.pending,
      merchant_id: 'merchant-1',
      assigned_rider_id: null,
    };

    it('cancels a pending order with canceled_by=merchant and the trimmed reason', async () => {
      prisma.orders.findUnique.mockResolvedValue(pendingOrder);
      prisma.merchant_users.findFirst.mockResolvedValue(membership);
      prisma.orders.updateMany.mockResolvedValue({ count: 1 });

      await service.merchantReject('order-1', merchantActor, '  no stock  ');

      expect(prisma.orders.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'order-1',
            assigned_rider_id: null,
            status: { in: [order_status.pending, order_status.preparing] },
          }) as Record<string, unknown>,
          data: {
            status: order_status.canceled,
            canceled_by: 'merchant',
            canceled_reason: 'no stock',
          },
        }),
      );
    });

    it('treats a missing/empty reason as null', async () => {
      prisma.orders.findUnique.mockResolvedValue(pendingOrder);
      prisma.merchant_users.findFirst.mockResolvedValue(membership);
      prisma.orders.updateMany.mockResolvedValue({ count: 1 });

      await service.merchantReject('order-1', merchantActor);

      expect(prisma.orders.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            canceled_reason: null,
          }) as Record<string, unknown>,
        }),
      );
    });

    it("404s a merchant who is not a member of the order's store (not-yours = not-found)", async () => {
      prisma.orders.findUnique.mockResolvedValue(pendingOrder);
      prisma.merchant_users.findFirst.mockResolvedValue(null);

      await expect(
        service.merchantReject('order-1', merchantActor),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.orders.updateMany).not.toHaveBeenCalled();
    });

    it('404s when the order does not exist', async () => {
      prisma.orders.findUnique.mockResolvedValue(null);

      await expect(
        service.merchantReject('order-x', merchantActor),
      ).rejects.toThrow(NotFoundException);
    });

    it('lets an admin reject without a membership row', async () => {
      prisma.orders.findUnique.mockResolvedValue(pendingOrder);
      prisma.orders.updateMany.mockResolvedValue({ count: 1 });

      await service.merchantReject('order-1', { id: 'admin-1', role: 'admin' });

      expect(prisma.merchant_users.findFirst).not.toHaveBeenCalled();
      expect(prisma.orders.updateMany).toHaveBeenCalled();
    });

    it('409s once a rider has been assigned', async () => {
      prisma.orders.findUnique.mockResolvedValue({
        ...pendingOrder,
        status: order_status.accepted,
        assigned_rider_id: 'rider-1',
      });
      prisma.merchant_users.findFirst.mockResolvedValue(membership);

      await expect(
        service.merchantReject('order-1', merchantActor),
      ).rejects.toThrow(ConflictException);
      expect(prisma.orders.updateMany).not.toHaveBeenCalled();
    });

    it('409s when the order is past preparing (e.g. delivered)', async () => {
      prisma.orders.findUnique.mockResolvedValue({
        ...pendingOrder,
        status: order_status.delivered,
      });
      prisma.merchant_users.findFirst.mockResolvedValue(membership);

      await expect(
        service.merchantReject('order-1', merchantActor),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('§1 — multi-stop orders', () => {
    // Two co-located stops → zero route distance → the ₱50 minimum fare
    // (5000¢) applies, making the money assertions deterministic.
    const stops = [
      { seq: 1, kind: 'deliver', label: 'B', lat: 10.5, lng: 122.1 },
      {
        seq: 0,
        kind: 'pickup',
        label: 'A',
        lat: 10.5,
        lng: 122.1,
        payload: { item: 'docs' },
      },
    ];

    beforeEach(() => {
      prisma.orders.create.mockImplementation(
        (args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'order-ms', ...args.data, order_stops: [] }),
      );
    });

    it('creates a multi_stop order born ready_for_pickup with the stops fanned out', async () => {
      await service.placeMultiStopOrder('cust-1', { stops, notes: 'Fragile' });

      expect(prisma.orders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            customer_id: 'cust-1',
            type: order_type.multi_stop,
            status: order_status.ready_for_pickup,
            notes: 'Fragile',
            order_stops: {
              create: [
                expect.objectContaining({ seq: 0, kind: 'pickup' }),
                expect.objectContaining({ seq: 1, kind: 'deliver' }),
              ],
            },
          }) as Record<string, unknown>,
          include: { order_stops: true },
        }),
      );
    });

    it('mirrors the first stop into pickup_* and the last into dropoff_* (feed proximity + display)', async () => {
      await service.placeMultiStopOrder('cust-1', {
        stops: [
          { seq: 0, kind: 'pickup', label: 'Start', lat: 10.1, lng: 122.1 },
          { seq: 1, kind: 'deliver', label: 'Mid', lat: 10.2, lng: 122.2 },
          { seq: 2, kind: 'deliver', label: 'End', lat: 10.3, lng: 122.3 },
        ],
      });

      expect(prisma.orders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pickup_lat: 10.1,
            pickup_lng: 122.1,
            pickup_text: 'Start',
            dropoff_lat: 10.3,
            dropoff_lng: 122.3,
            dropoff_text: 'End',
          }) as Record<string, unknown>,
        }),
      );
    });

    it('charges the minimum fare for a zero-distance route, payout = fee = total', async () => {
      const result = await service.placeMultiStopOrder('cust-1', { stops });

      expect(prisma.orders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            delivery_fee: 5000n,
            delivery_payout: 5000n,
            total: 5000n,
          }) as Record<string, unknown>,
        }),
      );
      expect(result.ref_no).toMatch(/^CMN-\d{6}$/);
    });

    it('rejects non-contiguous seq values (0,2)', async () => {
      await expect(
        service.placeMultiStopOrder('cust-1', {
          stops: [
            { seq: 0, kind: 'pickup', lat: 10, lng: 122 },
            { seq: 2, kind: 'deliver', lat: 10, lng: 122 },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.orders.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate seq values (0,0)', async () => {
      await expect(
        service.placeMultiStopOrder('cust-1', {
          stops: [
            { seq: 0, kind: 'pickup', lat: 10, lng: 122 },
            { seq: 0, kind: 'deliver', lat: 10, lng: 122 },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
