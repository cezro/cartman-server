import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { serializeOrder } from '../orders/serialize-order';

@Injectable()
export class RidersService {
  constructor(private readonly prisma: PrismaService) {}

  async createRider(userId: string, data: any) {
    return this.prisma.riders.create({
      data: {
        id: userId,
        ...data,
      },
    });
  }

  async activateRider(riderId: string, isActive: boolean) {
    return this.prisma.riders.update({
      where: { id: riderId },
      data: { is_active: isActive },
    });
  }

  async toggleDuty(riderId: string, isActive: boolean) {
    return this.prisma.riders.update({
      where: { id: riderId },
      data: { is_active: isActive },
    });
  }

  async logTelemetry(riderId: string, locations: any[]) {
    if (!locations || locations.length === 0) return { count: 0 };

    const data = locations.map((loc) => ({
      rider_id: riderId,
      lat: loc.lat,
      lng: loc.lng,
      order_id: loc.order_id,
      recorded_at: loc.recorded_at ? new Date(loc.recorded_at) : new Date(),
    }));

    return this.prisma.rider_locations.createMany({
      data,
    });
  }

  async getDeliveryHistory(riderId: string) {
    const orders = await this.prisma.orders.findMany({
      where: { assigned_rider_id: riderId, status: 'delivered' },
      orderBy: { updated_at: 'desc' },
      take: 20,
      include: {
        order_items: true,
        order_stops: true,
      },
    });
    return orders.map((order) => serializeOrder(order));
  }
}
