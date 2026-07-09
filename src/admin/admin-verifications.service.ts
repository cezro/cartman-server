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
    const { limit, offset, status } = query;
    const where: Record<string, unknown> = {};
    if (status) where.status = status;

    const [items, total] = await Promise.all([
      this.prisma.verifications.findMany({
        where,
        orderBy: { submitted_at: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.verifications.count({ where }),
    ]);
    return { items, total, limit, offset };
  }

  async approve(id: string) {
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
      await tx.riders.updateMany({
        where: { id: verification.user_id },
        data: { is_verified: true },
      });
      return updated;
    });
  }

  async reject(id: string) {
    const result = await this.prisma.verifications.updateMany({
      where: { id },
      data: { status: 'Rejected' },
    });
    if (result.count === 0) {
      throw new NotFoundException('Verification not found');
    }
    // Re-upload notification is a no-op for now — push/email delivery is held
    // (FCM stub + Brevo pending). The Rejected status is what the mobile app
    // will read to prompt a re-upload once notifications land.
    return this.prisma.verifications.findUnique({ where: { id } });
  }
}
