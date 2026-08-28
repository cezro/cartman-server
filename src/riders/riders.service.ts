import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { serializeOrder } from '../orders/serialize-order';

/**
 * What a rider's onboarding review is filed as. `verifications` also carries
 * merchant business permits, so the type is what tells the two apart in the
 * admin queue.
 */
export const RIDER_VERIFICATION_TYPE = 'Rider ID';

@Injectable()
export class RidersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Put a new rider in front of an admin.
   *
   * Riders are created with `is_verified = false` and cannot work until an
   * admin approves them, but **nothing ever created the row that approval acts
   * on** — no code path in any of the three repos inserted into
   * `verifications`. So a rider signed up, was told "we're reviewing your
   * account", and joined a queue that stayed empty; the five verified riders in
   * production got there by hand.
   *
   * `document_url` is empty at this point and that is the honest state: the
   * rider has submitted nothing yet. The row exists so somebody is *visible* as
   * waiting — `POST /riders/me/verification` is what attaches the document.
   *
   * Idempotent on the open row rather than on the rider, so a rejected rider
   * who re-applies opens a fresh review instead of silently reusing the old
   * decision.
   */
  private async ensureVerificationRequest(userId: string) {
    const open = await this.prisma.verifications.findFirst({
      where: { user_id: userId, status: 'Pending' },
    });
    if (open) return open;

    return this.prisma.verifications.create({
      data: {
        user_id: userId,
        document_type: RIDER_VERIFICATION_TYPE,
        document_url: '',
        status: 'Pending',
      },
    });
  }

  /**
   * Attach (or replace) the document on the rider's open review.
   *
   * Creates the review if there is none, so a rider provisioned before this
   * existed — or by the seed, or by hand — can still submit without an admin
   * having to open one for them.
   */
  async submitVerificationDocument(
    userId: string,
    data: { document_url: string; document_type?: string },
  ) {
    const open = await this.ensureVerificationRequest(userId);
    return this.prisma.verifications.update({
      where: { id: open.id },
      data: {
        document_url: data.document_url,
        document_type: data.document_type ?? RIDER_VERIFICATION_TYPE,
        // Restamped so the queue sorts on when the rider actually submitted,
        // not on when the empty placeholder was opened.
        submitted_at: new Date(),
      },
    });
  }

  async createRider(userId: string, data: any) {
    const rider = await this.prisma.riders.create({
      data: {
        id: userId,
        ...data,
      },
    });
    await this.ensureVerificationRequest(userId);
    return rider;
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
   * rider, so the admin COD/permit approval gate
   * (POST /admin/verifications/:id/approve) still applies.
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
      // Self-healing on the idempotent path too: a rider provisioned before
      // this enqueued anything is stuck at `is_verified = false` with no row
      // for an admin to act on, and re-running onboarding is the one thing
      // they would naturally try. Cheap, and it un-strands them.
      if (!existing.is_verified) await this.ensureVerificationRequest(userId);
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
        // In the same transaction as the promotion: a rider who exists but is
        // in no queue is exactly the stranded state this fixes, and it must
        // not be reachable by a half-applied onboarding.
        await tx.verifications.create({
          data: {
            user_id: userId,
            document_type: RIDER_VERIFICATION_TYPE,
            document_url: '',
            status: 'Pending',
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
