import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { haversineKm } from '../orders/geo';
import { order_status } from '@prisma/client';

/**
 * How close counts as arrived, in metres.
 *
 * A judgement call, and the one number here most likely to need tuning. Urban
 * PH GPS lands within roughly 20–50m, so anything tighter produces misses on
 * a rider who really is outside; anything much wider fires while they are
 * still a block away in dense barangay streets. 150m is the compromise, and
 * it is deliberately a single constant so tuning it is a one-line change.
 */
const ARRIVAL_RADIUS_M = 150;

/**
 * How old a fix may be and still describe where the rider *is*.
 *
 * The client queues fixes through a dead zone and drains them on reconnect, so
 * a burst of backdated fixes is normal and not a spoof — but announcing on one
 * tells a store someone is outside who left ten minutes ago.
 */
const FIX_FRESHNESS_MS = 3 * 60_000;

/** How many orders one pass will consider. */
const SWEEP_BATCH = 200;

/**
 * How far back the de-duplication looks.
 *
 * `push_outbox`'s only index is partial — `(created_at) where sent_at is null`
 * — and the rows this reads are already sent, so **no index can serve this
 * query**. An unbounded read therefore scans the whole table every minute, and
 * that table grows a row per order transition forever. A window is the defence.
 *
 * A day is far longer than any order stays live. One that is somehow still open
 * past it and re-enters the radius earns a second notification — a better
 * failure than scanning the platform's entire arrival history once a minute.
 */
const DEDUP_WINDOW_MS = 24 * 60 * 60_000;

/** Before the goods are collected, the endpoint that matters is the store. */
const PRE_PICKUP: order_status[] = [
  order_status.accepted,
  order_status.ready_for_pickup,
  order_status.arrived_at_merchant,
];

/** Once carrying, it is the customer's door. */
const CARRYING: order_status[] = [
  order_status.picked_up,
  order_status.in_transit,
];

const AT_MERCHANT_EVENT = 'rider.at_merchant';
const AT_DROPOFF_EVENT = 'rider.at_dropoff';

/**
 * H10 — arrival detection.
 *
 * Nothing notices that a rider reached the merchant or the door: every
 * transition is a manual tap, so `arrived_at_merchant` is only as accurate as
 * a busy rider's memory. What that costs is a store with no signal the rider
 * is outside (food under a heat lamp, or a rider waiting), and a customer
 * whose tracking screen goes quiet across the longest stretch of the order.
 *
 * The pieces already existed — `rider_locations` streams a fix per order and
 * orders carry `dropoff_lat/lng` — so this is a comparison, not new plumbing.
 *
 * **Notification-only, by decision.** Making arrival a new order status would
 * mean touching every `switch` over `OrderStatus` in both apps, and
 * auto-advancing the order would put a noisy sensor on its write path. This
 * writes `push_outbox` rows and stops; the rider still taps.
 */
@Injectable()
export class ArrivalService {
  private readonly logger = new Logger(ArrivalService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error(
        `Arrival sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async sweep(): Promise<{ arrivals: number; notified: number }> {
    const live = await this.prisma.orders.findMany({
      where: {
        status: { in: [...PRE_PICKUP, ...CARRYING] },
        assigned_rider_id: { not: null },
      },
      select: {
        id: true,
        ref_no: true,
        customer_id: true,
        merchant_id: true,
        status: true,
        dropoff_lat: true,
        dropoff_lng: true,
        merchant: { select: { name: true, lat: true, lng: true } },
      },
      // An unordered LIMIT in Postgres returns an arbitrary 200 rows, and which
      // 200 can change between passes over identical data — so past 200 live
      // orders this would stop processing a backlog and start *sampling* it,
      // with an order able to sit inside the radius and never be picked.
      // Oldest-touched first makes the batch a queue, matching the three
      // sibling sweepers.
      orderBy: { updated_at: 'asc' },
      take: SWEEP_BATCH,
    });
    if (live.length === 0) return { arrivals: 0, notified: 0 };

    const orderIds = live.map((o) => o.id);

    const fixes = await this.prisma.rider_locations.findMany({
      where: {
        order_id: { in: orderIds },
        recorded_at: { gte: new Date(Date.now() - FIX_FRESHNESS_MS) },
      },
      select: { order_id: true, lat: true, lng: true, recorded_at: true },
      orderBy: { recorded_at: 'desc' },
    });

    // Newest fix per order. The query is already sorted, so the first one seen
    // for an order wins.
    const latest = new Map<string, { lat: number; lng: number }>();
    for (const f of fixes) {
      if (f.order_id && !latest.has(f.order_id)) {
        latest.set(f.order_id, { lat: f.lat, lng: f.lng });
      }
    }

    const arrived: {
      order: (typeof live)[number];
      event: string;
    }[] = [];

    for (const o of live) {
      const fix = latest.get(o.id);
      if (!fix) continue;

      const carrying = CARRYING.includes(o.status);
      // Measured against the endpoint the rider is actually heading for.
      // Comparing against the wrong one announces an arrival at a place they
      // have not gone to yet.
      const target = carrying
        ? { lat: o.dropoff_lat, lng: o.dropoff_lng }
        : { lat: o.merchant?.lat, lng: o.merchant?.lng };

      // Both are nullable in the schema. A missing coordinate is not 0,0 —
      // that is a point in the Gulf of Guinea, and treating it as the endpoint
      // would be a silent wrong answer rather than a skip.
      if (target.lat == null || target.lng == null) continue;

      const metres =
        haversineKm(fix.lat, fix.lng, target.lat, target.lng) * 1000;
      if (metres > ARRIVAL_RADIUS_M) continue;

      arrived.push({
        order: o,
        event: carrying ? AT_DROPOFF_EVENT : AT_MERCHANT_EVENT,
      });
    }
    if (arrived.length === 0) return { arrivals: 0, notified: 0 };

    // Only fetched once we know somebody has arrived — most passes find
    // nobody, and this is a join we would otherwise pay for every minute.
    const merchantIds = arrived
      .filter((a) => a.event === AT_MERCHANT_EVENT)
      .map((a) => a.order.merchant_id)
      .filter((id): id is string => id !== null);
    const members = merchantIds.length
      ? await this.prisma.merchant_users.findMany({
          where: { merchant_id: { in: merchantIds } },
          select: { user_id: true, merchant_id: true },
        })
      : [];

    const rows = arrived.flatMap(({ order: o, event }) => {
      const ref = o.ref_no ?? '';
      if (event === AT_DROPOFF_EVENT) {
        return [
          {
            user_id: o.customer_id,
            event,
            title: 'Your rider is here',
            body: `Your rider has arrived with ${ref}.`,
            data: { order_id: o.id },
          },
        ];
      }
      return members
        .filter((m) => m.merchant_id === o.merchant_id)
        .map((m) => ({
          user_id: m.user_id,
          event,
          title: 'Rider is outside',
          body: `A rider is at the store for ${ref}.`,
          data: { order_id: o.id },
        }));
    });
    if (rows.length === 0) return { arrivals: 0, notified: 0 };

    // De-dup runs *last*, not first, and is bounded twice over.
    //
    // Bounded because this cannot use `push_outbox`'s only index (partial, on
    // unsent rows) and the table only grows: restricting it to the recipients
    // we are about to write for and to a recent window is what keeps it from
    // materialising the platform's entire arrival history once a minute.
    //
    // Last because most passes find nobody has arrived, and those now pay for
    // no de-dup query at all — the same reasoning that already defers the
    // `merchant_users` join below the radius check.
    //
    // Keyed on order *and* event: both arrivals happen on the same order, so
    // de-duping on `order_id` alone would mean the customer is never told the
    // rider is at the door.
    //
    // This reads rows that have already been *sent*, which makes the outbox a
    // record and not only a queue. That is a deliberate contract, not an
    // oversight — `20260810000200_push_outbox.sql` carries the matching note,
    // and it is why those rows must never be pruned.
    const announced = await this.prisma.push_outbox.findMany({
      where: {
        event: { in: [AT_MERCHANT_EVENT, AT_DROPOFF_EVENT] },
        user_id: { in: [...new Set(rows.map((r) => r.user_id))] },
        created_at: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) },
      },
      select: { event: true, data: true },
    });
    const seen = new Set(
      announced
        .map((r) => {
          const id = (r.data as { order_id?: string } | null)?.order_id;
          return id ? `${r.event}:${id}` : null;
        })
        .filter((k): k is string => k !== null),
    );

    const fresh = rows.filter(
      (r) => !seen.has(`${r.event}:${r.data.order_id}`),
    );
    if (fresh.length === 0) return { arrivals: 0, notified: 0 };

    await this.prisma.push_outbox.createMany({ data: fresh });

    // Counted from what was actually written: one arrival can fan out to
    // several store members, and a partly-announced order must not be counted
    // twice.
    const arrivals = new Set(fresh.map((r) => r.data.order_id)).size;
    this.logger.log(
      `Arrival sweep: ${arrivals} arrivals, ${fresh.length} notified`,
    );
    return { arrivals, notified: fresh.length };
  }
}
