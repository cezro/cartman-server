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

  async placeFoodOrder(customerId: string, data: any) {
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

      return tx.orders.create({
        data: {
          customer_id: customerId,
          merchant_id,
          merchant_name: merchant.name,
          type: order_type.food,
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
    });
  }

  async placeErrandOrder(customerId: string, data: any) {
    const { errand_payload, notes } = data;
    const delivery_fee = 10000n; // ₱100 — errand base fee
    const delivery_payout = delivery_fee;

    return this.prisma.orders.create({
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

    const distanceKm = this.getDistanceInKm(
      pickup_lat,
      pickup_lng,
      dropoff_lat,
      dropoff_lng,
    );

    // Fare: ₱40 base (4000¢) + ₱12/km (1200¢/km), minimum ₱50 (5000¢)
    const BASE = 4000n;
    const PER_KM = 1200n;
    const MIN_FEE = 5000n;
    const raw = BASE + BigInt(Math.round(distanceKm)) * PER_KM;
    const delivery_fee = raw < MIN_FEE ? MIN_FEE : raw;
    const delivery_payout = delivery_fee;

    return this.prisma.orders.create({
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
  }

  async getHistory(customerId: string) {
    return this.prisma.orders.findMany({
      where: { customer_id: customerId },
      orderBy: { created_at: 'desc' },
      take: 20,
      include: {
        merchant: { select: { name: true, image_url: true } },
      },
    });
  }

  async updateStatus(orderId: string, status: order_status) {
    return this.prisma.orders.update({
      where: { id: orderId },
      data: { status },
    });
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

    return this.prisma.orders.findUnique({ where: { id: orderId } });
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

    return order;
  }
}
