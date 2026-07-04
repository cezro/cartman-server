import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { order_type, order_status } from '@prisma/client';
import { LedgerService } from '../ledger/ledger.service';

const WALLET_LOCK_FLOOR = -200_000n; // -₱2,000 in centavos

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
  ) {}

  // Haversine straight-line distance in km
  private getDistanceInKm(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Prisma returns bigint centavo columns as JS BigInt, which Nest's default
  // JSON serializer cannot stringify. Centavo amounts are far under
  // Number.MAX_SAFE_INTEGER, so converting at the response boundary is safe.
  private serializeOrder<T extends Record<string, any>>(order: T): T {
    const moneyFields = [
      'subtotal',
      'delivery_fee',
      'discount',
      'total',
      'delivery_payout',
    ] as const;
    const out: Record<string, any> = { ...order };
    for (const field of moneyFields) {
      if (typeof out[field] === 'bigint') out[field] = Number(out[field]);
    }
    if (Array.isArray(out.order_items)) {
      out.order_items = out.order_items.map((item: Record<string, any>) =>
        typeof item.unit_price === 'bigint'
          ? { ...item, unit_price: Number(item.unit_price) }
          : item,
      );
    }
    return out as T;
  }

  async placeFoodOrder(customerId: string, data: any) {
    return this.placeMerchantOrder(customerId, data, order_type.food);
  }

  async placeGroceryOrder(customerId: string, data: any) {
    return this.placeMerchantOrder(customerId, data, order_type.grocery);
  }

  private async placeMerchantOrder(
    customerId: string,
    data: any,
    type: typeof order_type.food | typeof order_type.grocery,
  ) {
    const { merchant_id, items } = data;
    if (!items || items.length === 0) {
      throw new BadRequestException('Order must contain items');
    }

    return this.prisma.$transaction(async (tx) => {
      const merchant = await tx.merchants.findUnique({
        where: { id: merchant_id },
      });
      if (!merchant) throw new BadRequestException('Merchant not found');

      let subtotal = 0n;
      const orderItemsData = [];

      for (const item of items) {
        const menuItem = await tx.menu_items.findUnique({
          where: { id: item.menu_item_id },
        });
        if (!menuItem || menuItem.merchant_id !== merchant_id) {
          throw new BadRequestException(
            `Invalid menu item ${item.menu_item_id}`,
          );
        }
        if (!menuItem.in_stock) {
          throw new BadRequestException(
            `Item ${menuItem.name} is out of stock`,
          );
        }

        subtotal += BigInt(menuItem.price) * BigInt(item.qty);

        orderItemsData.push({
          menu_item_id: menuItem.id,
          name: menuItem.name,
          qty: item.qty,
          unit_price: menuItem.price,
          modifiers: item.modifiers || [],
        });
      }

      const delivery_fee = merchant.delivery_fee;
      const delivery_payout = delivery_fee; // rider gets full delivery fee (v1)
      const total = subtotal + delivery_fee;

      const order = await tx.orders.create({
        data: {
          customer_id: customerId,
          merchant_id,
          merchant_name: merchant.name,
          type,
          status: order_status.pending,
          subtotal,
          delivery_fee,
          delivery_payout,
          total,
          order_items: {
            create: orderItemsData,
          },
        },
        include: { order_items: true },
      });
      return this.serializeOrder(order);
    });
  }

  async placeErrandOrder(customerId: string, data: any) {
    const { errand_payload, notes } = data;
    const delivery_fee = 10000n; // ₱100 — errand base fee
    const delivery_payout = delivery_fee;

    const order = await this.prisma.orders.create({
      data: {
        customer_id: customerId,
        type: order_type.errand,
        status: order_status.pending,
        delivery_fee,
        delivery_payout,
        total: delivery_fee,
        errand_payload,
        notes,
      },
    });
    return this.serializeOrder(order);
  }

  async placeCourierOrder(customerId: string, data: any) {
    const {
      pickup_lat,
      pickup_lng,
      pickup_text,
      dropoff_lat,
      dropoff_lng,
      dropoff_text,
      notes,
      recipient_name,
      recipient_phone,
    } = data;

    if (!pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng) {
      throw new BadRequestException(
        'Pickup and dropoff coordinates are required',
      );
    }

    // Fare: ₱40 base (4000¢) + ₱12/km (1200¢/km), minimum ₱50 (5000¢)
    const delivery_fee = this.calcHaversineFare(
      pickup_lat,
      pickup_lng,
      dropoff_lat,
      dropoff_lng,
    );
    const delivery_payout = delivery_fee;

    const order = await this.prisma.orders.create({
      data: {
        customer_id: customerId,
        type: order_type.pickup_delivery,
        status: order_status.pending,
        pickup_lat,
        pickup_lng,
        pickup_text,
        dropoff_lat,
        dropoff_lng,
        dropoff_text,
        delivery_fee,
        delivery_payout,
        total: delivery_fee,
        notes,
        recipient_name,
        recipient_phone,
      },
    });
    return this.serializeOrder(order);
  }

  async placeRideOrder(customerId: string, data: any) {
    const {
      pickup_lat,
      pickup_lng,
      pickup_text,
      dropoff_lat,
      dropoff_lng,
      dropoff_text,
      notes,
    } = data;

    if (!pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng) {
      throw new BadRequestException(
        'Pickup and dropoff coordinates are required',
      );
    }

    // Reuses the same haversine fare curve as courier (TODO: confirm the
    // intended Pasakay base/per-km rate against the backlog docs — the
    // courier rate is used here as a placeholder, not a confirmed fare).
    const delivery_fee = this.calcHaversineFare(
      pickup_lat,
      pickup_lng,
      dropoff_lat,
      dropoff_lng,
    );
    const delivery_payout = delivery_fee;

    const order = await this.prisma.orders.create({
      data: {
        customer_id: customerId,
        type: order_type.ride,
        status: order_status.pending,
        pickup_lat,
        pickup_lng,
        pickup_text,
        dropoff_lat,
        dropoff_lng,
        dropoff_text,
        delivery_fee,
        delivery_payout,
        total: delivery_fee,
        notes,
      },
    });
    return this.serializeOrder(order);
  }

  private calcHaversineFare(
    pickupLat: number,
    pickupLng: number,
    dropoffLat: number,
    dropoffLng: number,
  ): bigint {
    const distanceKm = this.getDistanceInKm(
      pickupLat,
      pickupLng,
      dropoffLat,
      dropoffLng,
    );
    const BASE = 4000n;
    const PER_KM = 1200n;
    const MIN_FEE = 5000n;
    const raw = BASE + BigInt(Math.round(distanceKm)) * PER_KM;
    return raw < MIN_FEE ? MIN_FEE : raw;
  }

  async getHistory(customerId: string) {
    const orders = await this.prisma.orders.findMany({
      where: { customer_id: customerId },
      orderBy: { created_at: 'desc' },
      take: 20,
      include: {
        merchant: { select: { name: true, image_url: true } },
      },
    });
    return orders.map((order) => this.serializeOrder(order));
  }

  async updateStatus(orderId: string, status: order_status) {
    const order = await this.prisma.orders.update({
      where: { id: orderId },
      data: { status },
    });
    return this.serializeOrder(order);
  }

  async claimOrder(orderId: string, riderId: string) {
    const rider = await this.prisma.riders.findUnique({
      where: { id: riderId },
    });
    if (!rider?.is_active) {
      throw new BadRequestException('Go on-duty before claiming orders');
    }

    const netCash = await this.ledgerService.getNetCash(riderId);
    if (netCash <= WALLET_LOCK_FLOOR) {
      throw new BadRequestException(
        'Wallet locked — remit cash before accepting orders',
      );
    }

    const result = await this.prisma.orders.updateMany({
      where: {
        id: orderId,
        assigned_rider_id: null,
        status: order_status.ready_for_pickup,
      },
      data: {
        assigned_rider_id: riderId,
        status: order_status.accepted,
      },
    });

    if (result.count === 0) {
      throw new BadRequestException(
        'Order is no longer available or already claimed',
      );
    }

    const order = await this.prisma.orders.findUnique({
      where: { id: orderId },
    });
    return this.serializeOrder(order!);
  }

  async advanceRiderStatus(
    orderId: string,
    riderId: string,
    newStatus: order_status,
  ) {
    const order = await this.prisma.orders.update({
      where: {
        id: orderId,
        assigned_rider_id: riderId,
      },
      data: {
        status: newStatus,
      },
    });

    if (newStatus === order_status.delivered) {
      // Credit rider's delivery share (delivery_payout, not the full delivery_fee)
      await this.ledgerService.createManualTransaction(
        riderId,
        'credit_delivery_reward',
        Number(order.delivery_payout),
        order.id,
      );

      // Debit COD liability — amount is positive; sign comes from txn type
      if (order.payment === 'cod') {
        await this.ledgerService.createManualTransaction(
          riderId,
          'debit_cod_order',
          Number(order.total),
          order.id,
        );
      }
    }

    return this.serializeOrder(order);
  }
}
