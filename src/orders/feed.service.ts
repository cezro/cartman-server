import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { order_status, order_type } from '@prisma/client';
import { haversineKm } from './geo';
import { serializeOrder } from './serialize-order';

const AGE_CAP_MINUTES = 30;
const PAYOUT_CAP_CENTAVOS = 20_000;
const PROX_RANGE_KM = 10;
const RIDER_LOCATION_FRESHNESS_MINUTES = 10;
const CANDIDATE_LIMIT = 50;
const FEED_LIMIT = 20;

const TYPE_WEIGHTS: Record<order_type, number> = {
  ride: 1.0,
  food: 0.8,
  pickup_delivery: 0.6,
  grocery: 0.4,
  errand: 0.4,
  multi_stop: 0.4,
};

export interface FeedEntry {
  order: Record<string, any>;
  score: number;
  distance_km: number | null;
}

interface ScoredEntry extends FeedEntry {
  createdAtMs: number;
}

interface RiderPosition {
  lat: number;
  lng: number;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

@Injectable()
export class FeedService {
  private readonly wAge: number;
  private readonly wProx: number;
  private readonly wPayout: number;
  private readonly wType: number;

  constructor(
    private readonly prisma: PrismaService,
    // Not used directly by rankedFeed (ranking is advisory, no wallet gate
    // here) — kept for parity with the controller's DI graph and in case
    // future scoring wants to weight by rider standing.
    private readonly ledgerService: LedgerService,
  ) {
    this.wAge = parseFloat(process.env.FEED_W_AGE ?? '') || 0.4;
    this.wProx = parseFloat(process.env.FEED_W_PROX ?? '') || 0.3;
    this.wPayout = parseFloat(process.env.FEED_W_PAYOUT ?? '') || 0.2;
    this.wType = parseFloat(process.env.FEED_W_TYPE ?? '') || 0.1;
  }

  async rankedFeed(
    riderId: string,
    lat?: number,
    lng?: number,
  ): Promise<FeedEntry[]> {
    const [candidates, riderPos] = await Promise.all([
      this.prisma.orders.findMany({
        where: {
          status: order_status.ready_for_pickup,
          assigned_rider_id: null,
        },
        take: CANDIDATE_LIMIT,
        orderBy: { created_at: 'asc' },
        include: { order_items: true },
      }),
      this.resolveRiderPosition(riderId, lat, lng),
    ]);

    const now = Date.now();

    const scored: ScoredEntry[] = candidates.map((order) => {
      const createdAtMs = new Date(order.created_at).getTime();
      const ageMinutes = (now - createdAtMs) / 60_000;
      const ageNorm =
        Math.min(Math.max(ageMinutes, 0), AGE_CAP_MINUTES) / AGE_CAP_MINUTES;

      const payoutNorm =
        Math.min(Number(order.delivery_payout), PAYOUT_CAP_CENTAVOS) /
        PAYOUT_CAP_CENTAVOS;

      let distanceKm: number | null = null;
      let proximityNorm = 0;
      if (
        riderPos != null &&
        order.pickup_lat != null &&
        order.pickup_lng != null
      ) {
        distanceKm = haversineKm(
          riderPos.lat,
          riderPos.lng,
          order.pickup_lat,
          order.pickup_lng,
        );
        proximityNorm = Math.max(0, 1 - distanceKm / PROX_RANGE_KM);
      }

      const typeWeight = TYPE_WEIGHTS[order.type] ?? 0;

      const score =
        this.wAge * ageNorm +
        this.wProx * proximityNorm +
        this.wPayout * payoutNorm +
        this.wType * typeWeight;

      return {
        order: serializeOrder(order),
        score: round4(score),
        distance_km: distanceKm != null ? round4(distanceKm) : null,
        createdAtMs,
      };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.createdAtMs - b.createdAtMs; // tie-break: older first
    });

    return scored
      .slice(0, FEED_LIMIT)
      .map(({ order, score, distance_km }) => ({ order, score, distance_km }));
  }

  private async resolveRiderPosition(
    riderId: string,
    lat?: number,
    lng?: number,
  ): Promise<RiderPosition | null> {
    const freshnessFloor = new Date(
      Date.now() - RIDER_LOCATION_FRESHNESS_MINUTES * 60_000,
    );

    const latest = await this.prisma.rider_locations.findFirst({
      where: {
        rider_id: riderId,
        recorded_at: { gte: freshnessFloor },
      },
      orderBy: { recorded_at: 'desc' },
    });

    if (latest) {
      return { lat: latest.lat, lng: latest.lng };
    }

    if (
      lat != null &&
      lng != null &&
      !Number.isNaN(lat) &&
      !Number.isNaN(lng)
    ) {
      return { lat, lng };
    }

    return null;
  }
}
