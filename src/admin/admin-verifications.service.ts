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
   * Approve a verification row.
   *
   * Riders are NOT decided here. `admin_set_rider_verified` owns that: it
   * stamps `riders.is_verified`, the `rider_documents` row the rider actually
   * uploaded, and `verification_events` — from `auth.uid()`, in one
   * transaction. This service cannot call it (Prisma connections have no
   * `auth.uid()`), and a second writer to `is_verified` is exactly the
   * split-brain that let CartmanPH reach 5 verified riders with 0
   * verification_events. See
   * cartmanph-docs/docs/proposals/rider-verification-source-of-truth.md.
   *
   * @param actorId kept in the signature for the merchant permit flow, which
   *   still has no RPC of its own.
   */
  async approve(id: string, actorId: string) {
    void actorId;
    return this.prisma.$transaction(async (tx) => {
      const verification = await tx.verifications.findUnique({ where: { id } });
      if (!verification) throw new NotFoundException('Verification not found');
      return tx.verifications.update({
        where: { id },
        data: { status: 'Approved' },
      });
    });
  }

  /** Reject a verification row. Riders are not decided here — see approve(). */
  async reject(id: string, actorId: string) {
    void actorId;
    return this.prisma.$transaction(async (tx) => {
      const verification = await tx.verifications.findUnique({ where: { id } });
      if (!verification) throw new NotFoundException('Verification not found');
      return tx.verifications.update({
        where: { id },
        data: { status: 'Rejected' },
      });
    });
  }
}
