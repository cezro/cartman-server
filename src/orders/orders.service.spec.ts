import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { order_status, order_type, Prisma } from '@prisma/client';

// Shape of the update() call advanceRiderStatus issues, so mock.calls[0][0]
// reads as this rather than `any` (same approach as
// admin.service.mutations.spec.ts's OrdersUpdateManyCall).
interface OrdersUpdateCall {
  where: { id: string; assigned_rider_id?: string };
  data: { status: order_status; delivered_at?: Date };
}

describe('OrdersService', () => {
  let service: OrdersService;
  let prisma: {
    merchants: { findUnique: jest.Mock; updateMany: jest.Mock };
    menu_items: { findUnique: jest.Mock };
    orders: {
      create: jest.Mock;
      update: jest.Mock<Promise<unknown>, [OrdersUpdateCall]>;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    addresses: { findFirst: jest.Mock };
    riders: { findUnique: jest.Mock; updateMany: jest.Mock };
    rider_wallet_transactions: { findFirst: jest.Mock; create: jest.Mock };
    merchant_users: { findFirst: jest.Mock };
    order_ratings: { create: jest.Mock; aggregate: jest.Mock };
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
      merchants: { findUnique: jest.fn(), updateMany: jest.fn() },
      menu_items: { findUnique: jest.fn() },
      orders: {
        create: jest.fn(),
        update: jest.fn<Promise<unknown>, [OrdersUpdateCall]>(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      // Food/grocery orders resolve their drop-off from the customer's
      // default saved address when the body carries none. Every customer in
      // these fixtures has one; the "no address at all" case is asserted
      // explicitly in 2.5.
      addresses: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'addr-1',
          user_id: 'customer-1',
          label: 'Home',
          text_address: 'Lopez Jaena St, Jaro, Iloilo City',
          lat: 10.7145,
          lng: 122.5996,
          is_default: true,
        }),
      },
      riders: { findUnique: jest.fn(), updateMany: jest.fn() },
      rider_wallet_transactions: { findFirst: jest.fn(), create: jest.fn() },
      merchant_users: { findFirst: jest.fn() },
      order_ratings: { create: jest.fn(), aggregate: jest.fn() },
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

    it('placeErrandOrder stores the drop-off and the structured payload', async () => {
      prisma.orders.create.mockResolvedValue({
        id: 'order-1',
        status: order_status.ready_for_pickup,
      });

      await service.placeErrandOrder('cust-1', {
        errand_payload: {
          items: ['Biogesic 500mg'],
          store: 'Mercury Drug',
          budget_centavos: 50000,
        },
        notes: 'Buy: Biogesic 500mg · Store: Mercury Drug',
        dropoff_lat: 10.1,
        dropoff_lng: 122.1,
        dropoff_text: 'Home',
      });

      expect(prisma.orders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            dropoff_lat: 10.1,
            dropoff_lng: 122.1,
            dropoff_text: 'Home',
            errand_payload: expect.objectContaining({
              store: 'Mercury Drug',
            }) as Record<string, unknown>,
          }) as Record<string, unknown>,
        }),
      );
    });

    it('placeErrandOrder rejects a missing drop-off (unfulfillable order)', async () => {
      await expect(
        service.placeErrandOrder('cust-1', {
          errand_payload: {},
          notes: '',
        }),
      ).rejects.toThrow('Drop-off coordinates are required');
      expect(prisma.orders.create).not.toHaveBeenCalled();
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

    it('placeFoodOrder stores the customer note on the order (cart "note for the restaurant")', async () => {
      prisma.merchants.findUnique.mockResolvedValue({
        id: 'm-1',
        name: 'Kusina',
        delivery_fee: 4900n,
      });
      prisma.menu_items.findUnique.mockResolvedValue({
        id: 'mi-1',
        merchant_id: 'm-1',
        name: 'Adobo',
        price: 12000n,
        in_stock: true,
      });
      prisma.orders.create.mockResolvedValue({ id: 'order-n' });

      await service.placeFoodOrder('cust-1', {
        merchant_id: 'm-1',
        items: [{ menu_item_id: 'mi-1', qty: 1 }],
        notes: 'No onions please',
      });

      expect(prisma.orders.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            notes: 'No onions please',
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

  // I3b + I2. Food and grocery were the only order types that never wrote a
  // drop-off, so a live order reached the rider with no destination at all.
  describe('2.5 — merchant orders carry a drop-off', () => {
    const merchantAndItem = () => {
      prisma.merchants.findUnique.mockResolvedValue({
        id: 'm-1',
        name: 'Kusina',
        delivery_fee: 4900n,
      });
      prisma.menu_items.findUnique.mockResolvedValue({
        id: 'mi-1',
        merchant_id: 'm-1',
        name: 'Adobo',
        price: 12000n,
        in_stock: true,
      });
      prisma.orders.create.mockResolvedValue({ id: 'order-x' });
    };

    const createdData = () =>
      (prisma.orders.create.mock.calls[0][0] as { data: Record<string, any> })
        .data;

    it('persists dropoff_instruction and dropoff_note (I3b)', async () => {
      merchantAndItem();

      await service.placeFoodOrder('customer-1', {
        merchant_id: 'm-1',
        items: [{ menu_item_id: 'mi-1', qty: 1 }],
        dropoff_instruction: 'leave_at_door',
        dropoff_note: 'Green gate, second floor',
      });

      expect(createdData()).toMatchObject({
        dropoff_instruction: 'leave_at_door',
        dropoff_note: 'Green gate, second floor',
      });
    });

    it('leaves the instruction undefined when the body omits it, so the DB default (hand_to_me) stands', async () => {
      merchantAndItem();

      await service.placeFoodOrder('customer-1', {
        merchant_id: 'm-1',
        items: [{ menu_item_id: 'mi-1', qty: 1 }],
      });

      expect(createdData().dropoff_instruction).toBeUndefined();
      expect(createdData().dropoff_note).toBeUndefined();
    });

    it('falls back to the default saved address when the body carries no coordinates', async () => {
      merchantAndItem();

      await service.placeFoodOrder('customer-1', {
        merchant_id: 'm-1',
        items: [{ menu_item_id: 'mi-1', qty: 1 }],
      });

      // Ranked default-first, so a customer with several addresses still gets
      // the one checkout shows them.
      expect(prisma.addresses.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { user_id: 'customer-1' },
          orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
        }),
      );
      expect(createdData()).toMatchObject({
        dropoff_lat: 10.7145,
        dropoff_lng: 122.5996,
        dropoff_text: 'Lopez Jaena St, Jaro, Iloilo City',
      });
    });

    it('prefers a per-order drop-off over the default address (I2)', async () => {
      merchantAndItem();

      await service.placeGroceryOrder('customer-1', {
        merchant_id: 'm-1',
        items: [{ menu_item_id: 'mi-1', qty: 1 }],
        dropoff_lat: 10.7128,
        dropoff_lng: 122.5474,
        dropoff_text: 'SM City Iloilo, Mandurriao',
      });

      // The whole point of I2: ordering to somewhere else must not read, or
      // change, the saved default.
      expect(prisma.addresses.findFirst).not.toHaveBeenCalled();
      expect(createdData()).toMatchObject({
        dropoff_lat: 10.7128,
        dropoff_lng: 122.5474,
        dropoff_text: 'SM City Iloilo, Mandurriao',
      });
    });

    it('refuses an order it could never deliver — customer has no address at all', async () => {
      merchantAndItem();
      prisma.addresses.findFirst.mockResolvedValue(null);

      await expect(
        service.placeFoodOrder('customer-1', {
          merchant_id: 'm-1',
          items: [{ menu_item_id: 'mi-1', qty: 1 }],
        }),
      ).rejects.toThrow(/delivery address/i);

      expect(prisma.orders.create).not.toHaveBeenCalled();
    });
  });

  // ── M-5.2 — a paused store must refuse new orders on this path too ───────
  //
  // `place_order` (the DB twin) grew this guard in
  // 20260818000100_merchant_busy_until.sql. This service does not call that
  // RPC — it is a parallel implementation writing `orders` through Prisma — so
  // until now a client one version behind could order straight into a paused
  // kitchen. The migration header says so in as many words.
  // GO-LIVE S2 / server-handoff §9. The app sends the dish options the
  // customer chose; the server prices them from the menu, never the client.
  describe('S2 — dish options are priced server-side', () => {
    const groups = [
      {
        name: 'Size',
        required: true,
        max: 1,
        options: [
          { name: 'Regular', price: 0 },
          { name: 'Large', price: 3000 },
        ],
      },
      {
        name: 'Add-ons',
        required: false,
        max: 2,
        options: [{ name: 'Extra rice', price: 2500 }],
      },
    ];

    beforeEach(() => {
      prisma.merchants.findUnique.mockResolvedValue({
        id: 'm-1',
        name: 'Kusina',
        delivery_fee: 4900n,
      });
      prisma.menu_items.findUnique.mockResolvedValue({
        id: 'mi-1',
        merchant_id: 'm-1',
        name: 'Adobo',
        price: 12000n,
        in_stock: true,
        modifiers: groups,
      });
      prisma.orders.create.mockResolvedValue({ id: 'order-x' });
    });

    const createdData = () =>
      (prisma.orders.create.mock.calls[0][0] as { data: Record<string, any> })
        .data;

    it('stores both options at database prices, in the unit price and the total', async () => {
      await service.placeFoodOrder('customer-1', {
        merchant_id: 'm-1',
        items: [
          {
            menu_item_id: 'mi-1',
            qty: 2,
            // Client prices are wrong on purpose: they must not be used.
            modifiers: [
              { group: 'Size', name: 'Large', price: 1 },
              { group: 'Add-ons', name: 'Extra rice', price: 1 },
            ],
          },
        ],
        dropoff_instruction: 'leave_at_door',
        dropoff_note: '  Blue gate  ',
      });

      const data = createdData();
      const [line] = data.order_items.create as Array<Record<string, unknown>>;
      expect(line.modifiers).toEqual([
        { group: 'Size', name: 'Large', price: 3000 },
        { group: 'Add-ons', name: 'Extra rice', price: 2500 },
      ]);
      // 12000 + 3000 + 2500
      expect(line.unit_price).toBe(17500n);
      expect(data.subtotal).toBe(35000n);
      expect(data.total).toBe(35000n + 4900n);
      expect(data.dropoff_instruction).toBe('leave_at_door');
      expect(data.dropoff_note).toBe('Blue gate');
    });

    it('answers 409 (never 400) for an option the menu no longer has', async () => {
      await expect(
        service.placeFoodOrder('customer-1', {
          merchant_id: 'm-1',
          items: [
            {
              menu_item_id: 'mi-1',
              qty: 1,
              modifiers: [{ group: 'Size', name: 'Jumbo', price: 5000 }],
            },
          ],
        }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.orders.create).not.toHaveBeenCalled();
    });

    it('answers 409 when a required group is unanswered', async () => {
      await expect(
        service.placeFoodOrder('customer-1', {
          merchant_id: 'm-1',
          items: [{ menu_item_id: 'mi-1', qty: 1 }],
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('never prices a line below zero', async () => {
      prisma.menu_items.findUnique.mockResolvedValue({
        id: 'mi-1',
        merchant_id: 'm-1',
        name: 'Plain rice',
        price: 1000n,
        in_stock: true,
        modifiers: [
          {
            name: 'Size',
            options: [{ name: 'Half', price: -5000 }],
          },
        ],
      });

      await service.placeFoodOrder('customer-1', {
        merchant_id: 'm-1',
        items: [
          {
            menu_item_id: 'mi-1',
            qty: 1,
            modifiers: [{ group: 'Size', name: 'Half' }],
          },
        ],
      });

      const [line] = createdData().order_items.create as Array<
        Record<string, unknown>
      >;
      expect(line.unit_price).toBe(0n);
    });

    it('treats a blank drop-off note as no note (column stays null)', async () => {
      await service.placeFoodOrder('customer-1', {
        merchant_id: 'm-1',
        items: [
          {
            menu_item_id: 'mi-1',
            qty: 1,
            modifiers: [{ group: 'Size', name: 'Regular' }],
          },
        ],
        dropoff_note: '   ',
      });

      expect(createdData().dropoff_note).toBeUndefined();
    });
  });

  describe('M-5.2 — busy guard on merchant orders', () => {
    const busyStore = (busy_until: Date | null) => {
      prisma.merchants.findUnique.mockResolvedValue({
        id: 'm-1',
        name: 'Kusina',
        delivery_fee: 4900n,
        busy_until,
      });
      prisma.menu_items.findUnique.mockResolvedValue({
        id: 'mi-1',
        merchant_id: 'm-1',
        name: 'Adobo',
        price: 12000n,
        in_stock: true,
      });
      prisma.orders.create.mockResolvedValue({ id: 'order-x' });
    };

    const anOrder = () => ({
      merchant_id: 'm-1',
      items: [{ menu_item_id: 'mi-1', qty: 1 }],
    });

    it('refuses a food order while the store is paused', async () => {
      busyStore(new Date(Date.now() + 15 * 60_000));

      await expect(
        service.placeFoodOrder('customer-1', anOrder()),
      ).rejects.toThrow(ConflictException);
      expect(prisma.orders.create).not.toHaveBeenCalled();
    });

    it('refuses a grocery order while the store is paused', async () => {
      busyStore(new Date(Date.now() + 15 * 60_000));

      await expect(
        service.placeGroceryOrder('customer-1', anOrder()),
      ).rejects.toThrow(ConflictException);
      expect(prisma.orders.create).not.toHaveBeenCalled();
    });

    // 409, not 400. The body is well formed and the customer did nothing
    // wrong; it is the store's state that refuses, and it will stop refusing
    // on its own. The clients already treat 409 as "try again", 400 as "you
    // sent something invalid".
    it('answers 409, and says what the customer should do about it', async () => {
      busyStore(new Date(Date.now() + 15 * 60_000));

      await expect(
        service.placeFoodOrder('customer-1', anOrder()),
      ).rejects.toMatchObject({
        status: 409,
        // Same sentence the RPC raises, so a customer sees one wording
        // whichever write path their app version happens to use.
        message: 'This store has paused new orders. Please try again shortly.',
      });
    });

    // The pause expires by itself — that is the whole reason it is a timestamp
    // and not an `is_busy` flag. Reading it as "busy at any non-null value"
    // would shut the store permanently at the first pause.
    it('accepts an order once the pause has expired', async () => {
      busyStore(new Date(Date.now() - 60_000));

      await expect(
        service.placeFoodOrder('customer-1', anOrder()),
      ).resolves.toBeDefined();
      expect(prisma.orders.create).toHaveBeenCalled();
    });

    it('accepts an order from a store that has never paused (null)', async () => {
      busyStore(null);

      await expect(
        service.placeFoodOrder('customer-1', anOrder()),
      ).resolves.toBeDefined();
      expect(prisma.orders.create).toHaveBeenCalled();
    });

    // Cheapest rejection wins: a paused store should not send the server
    // through a menu-item lookup per line before it says no.
    it('rejects before pricing the basket', async () => {
      busyStore(new Date(Date.now() + 15 * 60_000));

      await expect(
        service.placeFoodOrder('customer-1', anOrder()),
      ).rejects.toThrow(ConflictException);
      expect(prisma.menu_items.findUnique).not.toHaveBeenCalled();
    });
  });

  // 20260803000200 gated the RLS feed policy and `accept_order` on
  // riders.is_verified, and left this path alone — but this is the path the
  // rider app claims through, and it reads via Prisma on a privileged
  // connection where RLS does not apply. So the gate never covered the live
  // path, and the only thing stopping an unapproved rider taking a COD order
  // was a screen in the Flutter app.
  describe('claim refuses an unapproved rider', () => {
    it('rejects before the duty check, and before any order is touched', async () => {
      prisma.riders.findUnique.mockResolvedValue({
        id: 'rider-1',
        is_active: true,
        is_verified: false,
      });

      await expect(service.claimOrder('order-1', 'rider-1')).rejects.toThrow(
        /still being reviewed/,
      );
      expect(prisma.orders.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an unapproved rider who is also off duty', async () => {
      // Approval is the more fundamental refusal: they are not "not working
      // right now", they are not yet allowed to work at all.
      prisma.riders.findUnique.mockResolvedValue({
        id: 'rider-1',
        is_active: false,
        is_verified: false,
      });

      await expect(service.claimOrder('order-1', 'rider-1')).rejects.toThrow(
        /still being reviewed/,
      );
    });

    it('rejects a rider row that does not exist at all', async () => {
      prisma.riders.findUnique.mockResolvedValue(null);

      await expect(service.claimOrder('order-1', 'rider-1')).rejects.toThrow(
        /still being reviewed/,
      );
    });
  });

  describe('a fresh errand order is claimable', () => {
    it('claimOrder succeeds when the order is ready_for_pickup and unassigned', async () => {
      prisma.riders.findUnique.mockResolvedValue({
        id: 'rider-1',
        is_active: true,
        is_verified: true,
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
      // The claim response is what the rider's active screen boots from —
      // it must carry the line items and the multi-stop route.
      expect(prisma.orders.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { order_items: true, order_stops: true },
        }),
      );
    });
  });

  describe('claim honours the vehicle an order is waiting for', () => {
    const riderOn = (vehicle: string) => ({
      id: 'rider-1',
      is_active: true,
      is_verified: true,
      vehicle,
    });

    beforeEach(() => {
      ledgerService.getNetCash.mockResolvedValue(0n);
      prisma.orders.count.mockResolvedValue(0);
    });

    it("puts the rider's vehicle inside the one conditional write", async () => {
      prisma.riders.findUnique.mockResolvedValue(riderOn('tricycle'));
      prisma.orders.updateMany.mockResolvedValue({ count: 1 });
      prisma.orders.findUnique.mockResolvedValue({
        id: 'order-1',
        status: order_status.accepted,
        assigned_rider_id: 'rider-1',
      });

      await service.claimOrder('order-1', 'rider-1');

      expect(prisma.orders.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [{ required_vehicle: null }, { required_vehicle: 'tricycle' }],
          }) as Record<string, unknown>,
        }),
      );
    });

    it('tells a motorcycle rider the order needs a tricycle', async () => {
      prisma.riders.findUnique.mockResolvedValue(riderOn('motorcycle'));
      prisma.orders.updateMany.mockResolvedValue({ count: 0 });
      prisma.orders.findUnique.mockResolvedValue({
        required_vehicle: 'tricycle',
      });

      await expect(service.claimOrder('order-1', 'rider-1')).rejects.toThrow(
        'This order needs a tricycle',
      );
    });

    it('a plain lost race still reads as one', async () => {
      prisma.riders.findUnique.mockResolvedValue(riderOn('motorcycle'));
      prisma.orders.updateMany.mockResolvedValue({ count: 0 });
      prisma.orders.findUnique.mockResolvedValue({ required_vehicle: null });

      await expect(service.claimOrder('order-1', 'rider-1')).rejects.toThrow(
        'Order is no longer available or already claimed',
      );
    });
  });

  describe('3.4 — claim queue-depth guard (max 1 active + 1 queued)', () => {
    beforeEach(() => {
      prisma.riders.findUnique.mockResolvedValue({
        id: 'rider-1',
        is_active: true,
        is_verified: true,
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
      // Only the real completion stamps a completion time.
      expect(
        prisma.orders.update.mock.calls[0][0].data.delivered_at,
      ).toBeUndefined();
    });

    // Parity with advance_order_status, which stamps delivered_at on this same
    // transition. This server reimplements that RPC rather than calling it, so
    // the two have to agree or completion times exist only for whichever path
    // the delivery happened to take.
    it('stamps delivered_at on the in_transit -> delivered transition', async () => {
      prisma.orders.findUnique.mockResolvedValue({
        id: 'order-1',
        status: order_status.in_transit,
        assigned_rider_id: 'rider-1',
      });
      prisma.orders.update.mockResolvedValue({
        id: 'order-1',
        status: order_status.delivered,
        assigned_rider_id: 'rider-1',
        delivery_payout: 5000n,
        payment: 'cod',
        total: 10000n,
      });
      prisma.rider_wallet_transactions.findFirst.mockResolvedValue(null);

      await service.advanceRiderStatus(
        'order-1',
        'rider-1',
        order_status.delivered,
      );

      const written = prisma.orders.update.mock.calls[0][0].data;
      expect(written.status).toBe(order_status.delivered);
      expect(written.delivered_at).toBeInstanceOf(Date);
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
        dropoff_lat: 10.1,
        dropoff_lng: 122.1,
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

  describe('§Ratings — rateOrder (POST /orders/:id/rating)', () => {
    const deliveredOrder = {
      id: 'order-1',
      customer_id: 'cust-1',
      merchant_id: 'merchant-1',
      assigned_rider_id: 'rider-1',
      status: order_status.delivered,
    };

    beforeEach(() => {
      prisma.orders.findUnique.mockResolvedValue(deliveredOrder);
      prisma.order_ratings.create.mockImplementation(
        (args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'rating-1', ...args.data }),
      );
      // Post-insert aggregate state: the just-inserted rating is the only
      // one → merchant avg 5, rider avg 4 (DB-twin happy-path values).
      prisma.order_ratings.aggregate.mockResolvedValue({
        _sum: { merchant_stars: 5, rider_stars: 4 },
        _count: { merchant_stars: 1, rider_stars: 1 },
      });
      prisma.merchants.updateMany.mockResolvedValue({ count: 1 });
      prisma.riders.updateMany.mockResolvedValue({ count: 1 });
    });

    it('rates a delivered merchant order and recomputes both aggregates (DB-twin happy path)', async () => {
      const result = await service.rateOrder('order-1', 'cust-1', {
        merchant_stars: 5,
        rider_stars: 4,
        comment: 'Sarap, mabilis!',
      });

      expect(prisma.order_ratings.create).toHaveBeenCalledWith({
        data: {
          order_id: 'order-1',
          customer_id: 'cust-1',
          merchant_id: 'merchant-1',
          rider_id: 'rider-1',
          merchant_stars: 5,
          rider_stars: 4,
          comment: 'Sarap, mabilis!',
        },
      });
      expect(prisma.merchants.updateMany).toHaveBeenCalledWith({
        where: { id: 'merchant-1' },
        data: { rating: 5 },
      });
      expect(prisma.riders.updateMany).toHaveBeenCalledWith({
        where: { id: 'rider-1' },
        data: { rating: 4 },
      });
      expect(result.merchant_stars).toBe(5);
      expect(result.rider_stars).toBe(4);
    });

    it('recomputes aggregates as round(avg, 2) over non-null stars only', async () => {
      prisma.order_ratings.aggregate.mockResolvedValue({
        _sum: { merchant_stars: 13, rider_stars: 9 },
        _count: { merchant_stars: 3, rider_stars: 2 },
      });

      await service.rateOrder('order-1', 'cust-1', {
        merchant_stars: 4,
        rider_stars: 4,
      });

      // 13/3 = 4.333… → 4.33; 9/2 = 4.5 — matches round(avg(stars), 2).
      expect(prisma.order_ratings.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { merchant_id: 'merchant-1', merchant_stars: { not: null } },
        }),
      );
      expect(prisma.order_ratings.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { rider_id: 'rider-1', rider_stars: { not: null } },
        }),
      );
      expect(prisma.merchants.updateMany).toHaveBeenCalledWith({
        where: { id: 'merchant-1' },
        data: { rating: 4.33 },
      });
      expect(prisma.riders.updateMany).toHaveBeenCalledWith({
        where: { id: 'rider-1' },
        data: { rating: 4.5 },
      });
    });

    it('a merchant-less order rates only the rider and never touches merchants', async () => {
      prisma.orders.findUnique.mockResolvedValue({
        ...deliveredOrder,
        merchant_id: null,
      });

      await service.rateOrder('order-1', 'cust-1', {
        rider_stars: 5,
        comment: 'Salamat kuya!',
      });

      expect(prisma.order_ratings.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          merchant_id: null,
          merchant_stars: null,
          rider_stars: 5,
        }) as Record<string, unknown>,
      });
      expect(prisma.merchants.updateMany).not.toHaveBeenCalled();
      expect(prisma.riders.updateMany).toHaveBeenCalled();
    });

    it('merchant_stars on a merchant-less order is stored inert — no merchant aggregate (RPC parity)', async () => {
      // The rate_order RPC does not reject merchant_stars here: the row keeps
      // the score with merchant_id null, so it can never feed any merchant's
      // aggregate. Mirror that exactly rather than inventing a 400.
      prisma.orders.findUnique.mockResolvedValue({
        ...deliveredOrder,
        merchant_id: null,
      });

      await service.rateOrder('order-1', 'cust-1', {
        merchant_stars: 4,
        rider_stars: 5,
      });

      expect(prisma.order_ratings.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          merchant_id: null,
          merchant_stars: 4,
        }) as Record<string, unknown>,
      });
      expect(prisma.merchants.updateMany).not.toHaveBeenCalled();
    });

    it('skips the rider aggregate when the order has no assigned rider (RPC parity)', async () => {
      prisma.orders.findUnique.mockResolvedValue({
        ...deliveredOrder,
        assigned_rider_id: null,
      });

      await service.rateOrder('order-1', 'cust-1', {
        merchant_stars: 3,
        rider_stars: 5,
      });

      expect(prisma.riders.updateMany).not.toHaveBeenCalled();
      expect(prisma.merchants.updateMany).toHaveBeenCalled();
    });

    it('trims the comment and stores blank as null (nullif(trim(…)) parity)', async () => {
      await service.rateOrder('order-1', 'cust-1', {
        rider_stars: 5,
        comment: '   ',
      });

      expect(prisma.order_ratings.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          comment: null,
        }) as Record<string, unknown>,
      });
    });

    it('404s when the order does not exist', async () => {
      prisma.orders.findUnique.mockResolvedValue(null);

      await expect(
        service.rateOrder('order-x', 'cust-1', { merchant_stars: 5 }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.order_ratings.create).not.toHaveBeenCalled();
    });

    it("404s when the order belongs to another customer (doesn't leak existence)", async () => {
      prisma.orders.findUnique.mockResolvedValue({
        ...deliveredOrder,
        customer_id: 'someone-else',
      });

      await expect(
        service.rateOrder('order-1', 'cust-1', { merchant_stars: 5 }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.order_ratings.create).not.toHaveBeenCalled();
    });

    it('409s an order that is not yet delivered', async () => {
      prisma.orders.findUnique.mockResolvedValue({
        ...deliveredOrder,
        status: order_status.in_transit,
      });

      await expect(
        service.rateOrder('order-1', 'cust-1', { merchant_stars: 5 }),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.rateOrder('order-1', 'cust-1', { merchant_stars: 5 }),
      ).rejects.toThrow('Only delivered orders can be rated');
      expect(prisma.order_ratings.create).not.toHaveBeenCalled();
    });

    it('400s when neither score is provided', async () => {
      await expect(
        service.rateOrder('order-1', 'cust-1', { comment: 'no stars' }),
      ).rejects.toThrow(BadRequestException);
      await expect(service.rateOrder('order-1', 'cust-1', {})).rejects.toThrow(
        'Provide a merchant or rider rating',
      );
      expect(prisma.order_ratings.create).not.toHaveBeenCalled();
    });

    it('409s a re-rate — the order_id UNIQUE surfaces as "Order already rated"', async () => {
      prisma.order_ratings.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.rateOrder('order-1', 'cust-1', { merchant_stars: 1 }),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.rateOrder('order-1', 'cust-1', { merchant_stars: 1 }),
      ).rejects.toThrow('Order already rated');
      // The transaction died on the insert — no aggregate may be recomputed.
      expect(prisma.merchants.updateMany).not.toHaveBeenCalled();
      expect(prisma.riders.updateMany).not.toHaveBeenCalled();
    });

    it('rethrows non-unique-violation errors untouched', async () => {
      prisma.order_ratings.create.mockRejectedValue(new Error('db down'));

      await expect(
        service.rateOrder('order-1', 'cust-1', { merchant_stars: 5 }),
      ).rejects.toThrow('db down');
    });
  });
});
