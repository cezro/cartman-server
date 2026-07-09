import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { CreateIncidentDto, UpdateIncidentStatusDto } from './dto/admin.dto';

/**
 * Admin Dashboard V2 — operational incident / system alert log.
 * incidents rows have no BigInt/Decimal columns, so Nest serializes them
 * as-is (Date → ISO). New per-domain service to keep admin.service.ts lean.
 */
@Injectable()
export class AdminIncidentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PaginationQueryDto) {
    const { limit, offset } = query;
    const [items, total] = await Promise.all([
      this.prisma.incidents.findMany({
        orderBy: { reported_at: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.incidents.count(),
    ]);
    return { items, total, limit, offset };
  }

  async create(body: CreateIncidentDto) {
    return this.prisma.incidents.create({
      data: {
        type: body.type,
        severity: body.severity,
        related_order: body.relatedOrder,
        assignee: body.assignee,
        // status omitted → DB default 'Open'.
      },
    });
  }

  async updateStatus(id: string, body: UpdateIncidentStatusDto) {
    const result = await this.prisma.incidents.updateMany({
      where: { id },
      data: { status: body.status },
    });
    if (result.count === 0) {
      throw new NotFoundException('Incident not found');
    }
    return this.prisma.incidents.findUnique({ where: { id } });
  }
}
