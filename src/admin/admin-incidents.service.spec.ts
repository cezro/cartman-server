import { NotFoundException } from '@nestjs/common';
import { AdminIncidentsService } from './admin-incidents.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateIncidentDto, UpdateIncidentStatusDto } from './dto/admin.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

function query(overrides: Partial<PaginationQueryDto>): PaginationQueryDto {
  return Object.assign(new PaginationQueryDto(), {
    limit: 20,
    offset: 0,
    ...overrides,
  });
}

describe('AdminIncidentsService', () => {
  let service: AdminIncidentsService;
  let prisma: {
    incidents: {
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      incidents: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    service = new AdminIncidentsService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('returns the pagination envelope ordered by reported_at desc', async () => {
      prisma.incidents.findMany.mockResolvedValue([{ id: 'i1' }]);
      prisma.incidents.count.mockResolvedValue(1);

      const res = await service.list(query({ limit: 10, offset: 5 }));

      expect(res).toEqual({ items: [{ id: 'i1' }], total: 1, limit: 10, offset: 5 });
      const call = prisma.incidents.findMany.mock.calls[0][0] as {
        orderBy: Record<string, string>;
        take: number;
        skip: number;
      };
      expect(call.orderBy).toEqual({ reported_at: 'desc' });
      expect(call.take).toBe(10);
      expect(call.skip).toBe(5);
    });
  });

  describe('create', () => {
    it('maps relatedOrder → related_order and defaults status to Open', async () => {
      const body: CreateIncidentDto = {
        type: 'payment',
        severity: 'high',
        relatedOrder: 'CMN-1',
        assignee: 'ops',
      };
      prisma.incidents.create.mockResolvedValue({ id: 'new', ...body });

      await service.create(body);

      const data = prisma.incidents.create.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data).toEqual({
        type: 'payment',
        severity: 'high',
        related_order: 'CMN-1',
        assignee: 'ops',
      });
      // status omitted → DB default 'Open' applies (not set explicitly here)
      expect(data.status).toBeUndefined();
    });
  });

  describe('updateStatus', () => {
    it('updates when the row exists', async () => {
      const body: UpdateIncidentStatusDto = { status: 'Investigating' };
      prisma.incidents.updateMany.mockResolvedValue({ count: 1 });
      prisma.incidents.findUnique.mockResolvedValue({
        id: 'i1',
        status: 'Investigating',
      });

      const res = await service.updateStatus('i1', body);

      expect(res).toEqual({ id: 'i1', status: 'Investigating' });
    });

    it('throws NotFound when the row is missing', async () => {
      prisma.incidents.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.updateStatus('missing', { status: 'Resolved' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
