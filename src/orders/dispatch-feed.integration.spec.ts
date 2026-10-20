// MM-4 proof (docs/go-live-gaps.md): errand (Pabili) / courier / ride /
// multi-stop orders have no merchant to advance them out of `pending`, so the
// dispatch rule is that they are born `ready_for_pickup` — this spec proves,
// through the REAL OrdersService and FeedService sharing one in-memory store,
// that placing one makes it visible in the rider feed immediately, while a
// food order stays out of the feed until the merchant accept → ready chain.
import { OrdersService } from './orders.service';
import { FeedService } from './feed.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { order_status, order_type } from '@prisma/client';

const NOW = new Date('2026-07-05T12:00:00.000Z');

type Row = Record<string, unknown>;
type NestedRows = { create?: Row[] } | undefined;

/**
 * Minimal stateful Prisma fake: one shared `orders` array with the DB's
 * column defaults, honest `where` filtering for the fields the feed and the
 * merchant transitions actually use. No jest.fn().mockResolvedValue snapshots
 * — reads always see the latest writes, like the real database.
 */
function makeFakePrisma() {
  const orders: Row[] = [];
  let orderSeq = 0;
  let refSeq = 0n;

  const merchant = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    name: 'Jollibee BGC',
    delivery_fee: 4900n,
    is_open: true,
    min_order: 0n,
  };
  const menuItem = {
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    merchant_id: merchant.id,
    name: 'Chickenjoy',
    price: 12000n,
    in_stock: true,
  };

  const matches = (row: Row, where: Row = {}): boolean => {
    for (const [key, cond] of Object.entries(where)) {
      if (key === 'OR') {
        if (!(cond as Row[]).some((branch) => matches(row, branch))) {
          return false;
        }
      } else if (cond !== null && typeof cond === 'object' && 'in' in cond) {
        if (!(cond as { in: unknown[] }).in.includes(row[key])) return false;
      } else if (row[key] !== cond) {
        return false;
      }
    }
    return true;
  };

  const prisma = {
    orders: {
      create: ({ data }: { data: Row }) => {
        const { order_items, order_stops, ...columns } = data;
        const row: Row = {
          id: `order-${++orderSeq}`,
          assigned_rider_id: null,
          merchant_id: null,
          merchant_name: null,
          payment: 'cod',
          subtotal: 0n,
          delivery_fee: 0n,
          discount: 0n,
          total: 0n,
          delivery_payout: 0n,
          pickup_lat: null,
          pickup_lng: null,
          required_vehicle: null,
          created_at: NOW,
          ...columns,
          order_items: ((order_items as NestedRows)?.create ?? []).map(
            (item, i) => ({ id: `item-${orderSeq}-${i}`, ...item }),
          ),
          order_stops: ((order_stops as NestedRows)?.create ?? []).map(
            (stop, i) => ({ id: `stop-${orderSeq}-${i}`, ...stop }),
          ),
        };
        orders.push(row);
        return Promise.resolve(row);
      },
      findUnique: ({ where }: { where: Row }) =>
        Promise.resolve(orders.find((o) => o.id === where.id) ?? null),
      findMany: ({ where }: { where?: Row } = {}) =>
        Promise.resolve(orders.filter((o) => matches(o, where))),
      update: ({ where, data }: { where: Row; data: Row }) => {
        const row = orders.find((o) => o.id === where.id);
        if (!row) return Promise.reject(new Error('not found'));
        Object.assign(row, data);
        return Promise.resolve(row);
      },
      updateMany: ({ where, data }: { where: Row; data: Row }) => {
        const hits = orders.filter((o) => matches(o, where));
        hits.forEach((o) => Object.assign(o, data));
        return Promise.resolve({ count: hits.length });
      },
      count: ({ where }: { where?: Row } = {}) =>
        Promise.resolve(orders.filter((o) => matches(o, where)).length),
    },
    merchants: {
      findUnique: ({ where }: { where: Row }) =>
        Promise.resolve(where.id === merchant.id ? merchant : null),
    },
    menu_items: {
      findUnique: ({ where }: { where: Row }) =>
        Promise.resolve(where.id === menuItem.id ? menuItem : null),
    },
    addresses: {
      // Food/grocery orders resolve their drop-off from the customer's
      // default saved address; every fixture customer has one.
      findFirst: () =>
        Promise.resolve({
          id: 'addr-1',
          label: 'Home',
          text_address: 'Lopez Jaena St, Jaro, Iloilo City',
          lat: 10.7145,
          lng: 122.5996,
          is_default: true,
        }),
    },
    merchant_users: {
      // 'store-owner' is a member of the one fake store; nobody else is.
      findFirst: ({ where }: { where: Row }) =>
        Promise.resolve(
          where.user_id === 'store-owner' && where.merchant_id === merchant.id
            ? { user_id: where.user_id, merchant_id: where.merchant_id }
            : null,
        ),
    },
    riders: {
      // 'trike-1' rides a tricycle; everyone else a motorcycle.
      findUnique: ({ where }: { where: Row }) =>
        Promise.resolve({
          id: where.id,
          is_active: true,
          is_verified: true,
          vehicle: where.id === 'trike-1' ? 'tricycle' : 'motorcycle',
        }),
    },
    rider_locations: { findFirst: () => Promise.resolve(null) },
    rider_wallet_transactions: {
      findFirst: () => Promise.resolve(null),
      create: () => Promise.resolve({}),
    },
    $queryRaw: () => {
      refSeq += 1n;
      return Promise.resolve([{ nextval: refSeq }]);
    },
    $transaction: (cb: (tx: unknown) => unknown) => Promise.resolve(cb(prisma)),
  };

  return prisma;
}

describe('dispatch → rider feed (MM-4 proof)', () => {
  let ordersService: OrdersService;
  let feedService: FeedService;
  let fake: ReturnType<typeof makeFakePrisma>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    fake = makeFakePrisma();
    const prisma = fake as unknown as PrismaService;
    const ledger = {
      getNetCash: jest.fn().mockResolvedValue(0n),
    } as unknown as LedgerService;
    ordersService = new OrdersService(prisma, ledger);
    feedService = new FeedService(prisma, ledger);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const feedIds = async () =>
    (await feedService.rankedFeed('rider-1')).map((e) => e.order.id as string);

  it('a freshly placed Pabili (errand) order is in the rider feed', async () => {
    const placed = await ordersService.placeErrandOrder('cust-1', {
      errand_payload: null,
      notes: 'Bili ng load sa sari-sari store',
      dropoff_lat: 10.1,
      dropoff_lng: 122.1,
    });

    const feed = await feedService.rankedFeed('rider-1');
    const entry = feed.find((e) => e.order.id === placed.id);

    expect(entry).toBeDefined();
    expect(entry!.order.type).toBe(order_type.errand);
    expect(entry!.order.status).toBe(order_status.ready_for_pickup);
    // Serialized for the wire: centavos as number, not BigInt.
    expect(typeof entry!.order.delivery_payout).toBe('number');
  });

  it('a freshly placed ride (Pasakay) order is in the rider feed with pickup proximity data', async () => {
    const placed = await ordersService.placeRideOrder('cust-1', {
      pickup_lat: 14.5547,
      pickup_lng: 121.0244,
      pickup_text: 'BGC',
      dropoff_lat: 14.5995,
      dropoff_lng: 120.9842,
      dropoff_text: 'Manila',
    });

    const feed = await feedService.rankedFeed('rider-1', 14.55, 121.02);
    const entry = feed.find((e) => e.order.id === placed.id);

    expect(entry).toBeDefined();
    expect(entry!.order.status).toBe(order_status.ready_for_pickup);
    expect(entry!.distance_km).not.toBeNull();
  });

  it('a freshly placed multi-stop order is in the rider feed', async () => {
    const placed = await ordersService.placeMultiStopOrder('cust-1', {
      stops: [
        { seq: 0, kind: 'pickup', label: 'QC', lat: 14.676, lng: 121.0437 },
        { seq: 1, kind: 'deliver', label: 'BGC', lat: 14.5547, lng: 121.0244 },
      ],
    });

    expect(await feedIds()).toContain(placed.id);
  });

  it('a food order stays out of the feed until merchant accept → ready; a claimed order leaves it', async () => {
    const food = await ordersService.placeFoodOrder('cust-1', {
      merchant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      items: [{ menu_item_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', qty: 1 }],
    });

    // pending → invisible to riders
    expect(await feedIds()).not.toContain(food.id);

    const merchant = { id: 'store-owner', role: 'merchant' };
    await ordersService.merchantAccept(food.id, merchant);
    // preparing → still invisible
    expect(await feedIds()).not.toContain(food.id);

    await ordersService.merchantMarkReady(food.id, merchant);
    // ready_for_pickup → dispatched to the feed
    expect(await feedIds()).toContain(food.id);

    // claimed by a rider → gone from everyone's feed
    await ordersService.claimOrder(food.id, 'rider-1');
    expect(await feedIds()).not.toContain(food.id);
  });

  it('an order handed back as too big reaches tricycles only', async () => {
    const parcel = await ordersService.placeErrandOrder('cust-1', {
      errand_payload: null,
      notes: 'Ref, two-door',
      dropoff_lat: 10.1,
      dropoff_lng: 122.1,
    });
    // What rider_request_bigger_vehicle leaves behind.
    await fake.orders.update({
      where: { id: parcel.id },
      data: { required_vehicle: 'tricycle' },
    });

    const idsFor = async (vehicle: string) =>
      (await feedService.rankedFeed('x', undefined, undefined, vehicle)).map(
        (e) => e.order.id as string,
      );
    expect(await idsFor('motorcycle')).not.toContain(parcel.id);
    expect(await idsFor('Honda Click 125i')).not.toContain(parcel.id);
    expect(await idsFor('tricycle')).toContain(parcel.id);

    // The claim agrees with the feed, and says why.
    await expect(
      ordersService.claimOrder(parcel.id, 'rider-1'),
    ).rejects.toThrow('This order needs a tricycle');
    const claimed = await ordersService.claimOrder(parcel.id, 'trike-1');
    expect(claimed.assigned_rider_id).toBe('trike-1');
  });
});
