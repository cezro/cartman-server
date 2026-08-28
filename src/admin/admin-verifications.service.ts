import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminVerificationsQueryDto } from './dto/admin.dto';

/**
 * Admin Dashboard V2 — COD ID / Merchant Business Permit review queue.
 * verifications rows have no BigInt/Decimal columns → serialized as-is.
 */
@Injectable()
export class AdminVerificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminVerificationsQueryDto) {
    const { limit, offset, status, user_id } = query;
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    // Server-side so a rider's own documents can be fetched directly. The
    // dashboard's rider-detail page used to pull `?limit=50` and filter in the
    // browser, which silently showed nothing once the platform had 50
    // verifications of any kind.
    if (user_id) where.user_id = user_id;

    const [items, total] = await Promise.all([
      this.prisma.verifications.findMany({
        where,
        orderBy: { submitted_at: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.verifications.count({ where }),
    ]);

    // Who the admin is actually approving.
    //
    // `verifications.user_id` has no foreign key to `profiles` and therefore no
    // Prisma relation to include — adding one would put a relation in the
    // mirror that does not exist in the database. So this is a second query and
    // a merge, which is also why it is bounded by the page rather than run per
    // row.
    //
    // Without it every row reached the dashboard with no name at all, and its
    // fallback chain rendered the whole queue as "Unknown User": an admin
    // approving an identity document against a name the screen could not show.
    const profiles = items.length
      ? await this.prisma.profiles.findMany({
          where: { id: { in: [...new Set(items.map((v) => v.user_id))] } },
          select: {
            id: true,
            full_name: true,
            role: true,
            phone: true,
            deleted_at: true,
          },
        })
      : [];
    const byId = new Map(profiles.map((p) => [p.id, p]));

    return {
      items: items.map((v) => {
        const p = byId.get(v.user_id);
        return {
          ...v,
          // Null rather than a placeholder string: the dashboard should be able
          // to tell "no profile row" apart from someone literally named that.
          user_name: p?.full_name ?? null,
          user_role: p?.role ?? null,
          user_phone: p?.phone ?? null,
          // A closed account still in the queue is not worth an admin's time,
          // and approving one would verify a tombstone.
          user_deleted: p ? p.deleted_at !== null : false,
        };
      }),
      total,
      limit,
      offset,
    };
  }

  /**
   * @param actorId the admin performing the approval, from the request JWT.
   *   Required, because the alternative is a verification gate with no record
   *   of who opened it.
   */
  async approve(id: string, actorId: string) {
    // One transaction: flip the verification to Approved and, if its user is a
    // rider, mark that rider verified. riders.id === profiles.id === user_id,
    // so updateMany on that id is a safe no-op when the user isn't a rider.
    return this.prisma.$transaction(async (tx) => {
      const verification = await tx.verifications.findUnique({ where: { id } });
      if (!verification) throw new NotFoundException('Verification not found');

      const updated = await tx.verifications.update({
        where: { id },
        data: { status: 'Approved' },
      });
      const { count } = await tx.riders.updateMany({
        where: { id: verification.user_id },
        data: { is_verified: true },
      });

      // The audit trail the SQL path gets for free. `admin_set_rider_verified`
      // writes this row itself, but it cannot be called from here: it reads
      // `auth.uid()` to authorise and to stamp `actor_id`, and that is null on
      // a Prisma connection. So this path has to write it — and until it did,
      // CartmanPH had 5 verified riders and 0 verification_events.
      //
      // Only when a rider row actually moved: `verifications` also carries
      // merchant business permits, where the updateMany above is a deliberate
      // no-op, and a 'rider' row there would describe something that never
      // happened.
      if (count > 0) {
        await tx.verification_events.create({
          data: {
            subject_kind: 'rider',
            subject_id: verification.user_id,
            approved: true,
            actor_id: actorId,
          },
        });
      }
      return updated;
    });
  }

  /**
   * @param actorId the admin performing the rejection. Required for the same
   *   reason as on approve — and arguably more so, since a rejection is the
   *   decision someone is likely to contest.
   */
  async reject(id: string, actorId: string) {
    return this.prisma.$transaction(async (tx) => {
      const verification = await tx.verifications.findUnique({ where: { id } });
      if (!verification) throw new NotFoundException('Verification not found');

      const updated = await tx.verifications.update({
        where: { id },
        data: { status: 'Rejected' },
      });

      // Rejection revokes. Without this, rejecting a rider who had been
      // approved on an earlier submission left `is_verified` true — the
      // decision was recorded and the access it controls was not, so the
      // rider kept taking COD orders on a document an admin had just refused.
      const { count } = await tx.riders.updateMany({
        where: { id: verification.user_id },
        data: { is_verified: false },
      });

      // Mirrors approve: the audit row is written here because
      // `admin_set_rider_verified` cannot be reached from a Prisma connection
      // (it reads `auth.uid()`, which is null here). Approve has done this
      // since the 5-verified-riders/0-events discrepancy; reject never did, so
      // the trail recorded who was let in and not who was turned away.
      if (count > 0) {
        await tx.verification_events.create({
          data: {
            subject_kind: 'rider',
            subject_id: verification.user_id,
            approved: false,
            actor_id: actorId,
          },
        });
      }

      // Telling the rider is still outstanding: `Rejected` is what the app
      // reads to prompt a re-upload, and `POST /riders/me/verification` is now
      // the route that re-opens the review — but nothing pushes the news, so
      // the rider only learns by reopening the app.
      return updated;
    });
  }
}
