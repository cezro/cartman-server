import { ConflictException, Injectable } from '@nestjs/common';
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

  /**
   * Promote an authenticated non-rider account into a rider.
   *
   * Exists because Google sign-in cannot become a rider any other way: GoTrue
   * won't let a client inject `raw_user_meta_data.role` during OAuth the way
   * the email/password sign-up form does, so `handle_new_user` provisions every
   * Google account as a plain 'customer' with no `riders` row — and the rider
   * app's router guard refuses a session whose `riderSelf()` is null. That's
   * also why this is the one riders route with no `@Roles('rider')`: requiring
   * the role you're asking to be granted is unreachable by definition.
   *
   * `is_verified` and `is_active` are left at their schema defaults (both
   * false) — self-service onboarding provisions an *unverified, off-duty*
   * rider. The rider becomes reviewable by uploading a document
   * (`rider_documents`); an admin then decides via
   * `admin_set_rider_verified`. No placeholder review row is opened, because
   * a rider who has uploaded nothing is waiting on themselves, not on an
   * admin.
   */
  async onboardRider(
    userId: string,
    data: { vehicle?: string; plate_no?: string; phone?: string },
  ) {
    // Idempotent: the OAuth deep link can re-deliver, and a rider who
    // backgrounds the app mid-flow can submit twice. Returning the existing
    // row beats a 500 on the primary-key collision, and must NOT re-run the
    // promotion (a rider who later edits their vehicle shouldn't have their
    // phone silently overwritten by a stale onboarding payload).
    const existing = await this.prisma.riders.findUnique({
      where: { id: userId },
    });
    if (existing) {
      return existing;
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const rider = await tx.riders.create({
          data: {
            id: userId,
            vehicle: data.vehicle ?? '',
            plate_no: data.plate_no ?? '',
          },
        });
        await tx.profiles.update({
          where: { id: userId },
          data: {
            role: 'rider',
            // Google gives us no phone number, and dispatch/customers contact
            // riders by phone — but only stamp it when supplied, so a re-run
            // with an empty body can't null out a good number.
            ...(data.phone ? { phone: data.phone } : {}),
          },
        });
        return rider;
      });
    } catch (e) {
      // profiles.phone is UNIQUE — surface "that number is taken" as a 409
      // rather than an opaque 500 the app can't explain to the rider.
      if ((e as { code?: string }).code === 'P2002') {
        throw new ConflictException(
          'That mobile number is already linked to another account.',
        );
      }
      throw e;
    }
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
