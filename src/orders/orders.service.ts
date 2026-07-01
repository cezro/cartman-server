import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { order_type, order_status } from '@prisma/client';
import { LedgerService } from '../ledger/ledger.service';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService
  ) {}

  // Helper for straight-line distance
  private getDistanceInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
    const R = 6371; // Radius of the earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in km
  }

  async placeFoodOrder(customerId: string, data: any) {
    // Expects { merchant_id, items: [{ menu_item_id, qty, modifiers }] }
    const { merchant_id, items } = data;
    if (!items || items.length === 0) {
      throw new BadRequestException('Order must contain items');
    }

    return this.prisma.$transaction(async (tx) => {
      let subtotal = 0n;
      const orderItemsData = [];

      for (const item of items) {
        const menuItem = await tx.menu_items.findUnique({ where: { id: item.menu_item_id } });
        if (!menuItem || menuItem.merchant_id !== merchant_id) {
          throw new BadRequestException(`Invalid menu item ${item.menu_item_id}`);
        }
        if (!menuItem.in_stock) {
          throw new BadRequestException(`Item ${menuItem.name} is out of stock`);
        }

        const lineTotal = BigInt(menuItem.price) * BigInt(item.qty);
        subtotal += lineTotal;

        orderItemsData.push({
          menu_item_id: menuItem.id,
          name: menuItem.name,
          qty: item.qty,
          unit_price: menuItem.price,
          modifiers: item.modifiers || [],
        });
      }

      // Hardcoded delivery fee placeholder for food (e.g. 50 pesos = 5000 centavos)
      const delivery_fee = 5000n; 
      const total = subtotal + delivery_fee;

      return tx.orders.create({
        data: {
          customer_id: customerId,
          merchant_id,
          type: order_type.food,
          status: order_status.pending,
          subtotal,
          delivery_fee,
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
    // Hardcoded delivery fee placeholder for errand (e.g. 100 pesos)
    const delivery_fee = 10000n; 

    return this.prisma.orders.create({
      data: {
        customer_id: customerId,
        type: order_type.errand,
        status: order_status.pending,
        delivery_fee,
        total: delivery_fee,
        errand_payload,
        notes,
      },
    });
  }

  async placeCourierOrder(customerId: string, data: any) {
    const { pickup_lat, pickup_lng, pickup_text, dropoff_lat, dropoff_lng, dropoff_text, notes, recipient_name, recipient_phone } = data;
    
    if (!pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng) {
      throw new BadRequestException('Pickup and dropoff coordinates are required');
    }

    const distanceKm = this.getDistanceInKm(pickup_lat, pickup_lng, dropoff_lat, dropoff_lng);
    
    // Base fee: 50 pesos (5000 centavos). Per km: 15 pesos (1500 centavos).
    const delivery_fee = 5000n + BigInt(Math.round(distanceKm * 1500));

    return this.prisma.orders.create({
      data: {
        customer_id: customerId,
        type: order_type.pickup_delivery,
        status: order_status.pending,
        pickup_lat, pickup_lng, pickup_text,
        dropoff_lat, dropoff_lng, dropoff_text,
        delivery_fee,
        total: delivery_fee,
        notes,
        recipient_name, recipient_phone
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
      }
    });
  }

  async updateStatus(orderId: string, status: order_status) {
    // Security note: In a real app, you'd verify the merchant_id owns the order
    // before allowing a status update.
    return this.prisma.orders.update({
      where: { id: orderId },
      data: { status },
    });
  }

  async claimOrder(orderId: string, riderId: string) {
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
      throw new BadRequestException('Order is no longer available or already claimed');
    }

    return this.prisma.orders.findUnique({ where: { id: orderId } });
  }

  async advanceRiderStatus(orderId: string, riderId: string, newStatus: order_status) {
    const order = await this.prisma.orders.update({
      where: {
        id: orderId,
        assigned_rider_id: riderId,
      },
      data: {
        status: newStatus,
      },
    });

    // Auto ledger logic when order is marked as delivered
    if (newStatus === order_status.delivered) {
      // 1. Credit Delivery Reward
      await this.ledgerService.createManualTransaction(
        riderId,
        'credit_delivery_reward',
        Number(order.delivery_fee), // Rider earns the delivery fee
        order.id
      );

      // 2. Debit COD Liability
      if (order.payment === 'cod') {
        await this.ledgerService.createManualTransaction(
          riderId,
          'debit_cod_order',
          -Number(order.total), // Deduct full order amount (cash they are holding)
          order.id
        );
      }
    }

    return order;
  }
}
