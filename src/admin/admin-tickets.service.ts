import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdminTicketsQueryDto,
  UpdateTicketStatusDto,
} from './dto/admin.dto';

/**
 * Admin Dashboard V2 — multi-channel support tickets.
 * tickets rows have no BigInt/Decimal columns → serialized as-is.
 */
@Injectable()
export class AdminTicketsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdminTicketsQueryDto) {
    const { limit, offset, status } = query;
    const where: Record<string, unknown> = {};
    if (status) where.status = status;

    const [items, total] = await Promise.all([
      this.prisma.tickets.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.tickets.count({ where }),
    ]);
    return { items, total, limit, offset };
  }

  async updateStatus(id: string, body: UpdateTicketStatusDto) {
    const result = await this.prisma.tickets.updateMany({
      where: { id },
      data: { status: body.status },
    });
    if (result.count === 0) {
      throw new NotFoundException('Ticket not found');
    }
    return this.prisma.tickets.findUnique({ where: { id } });
  }
}
