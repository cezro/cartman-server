import { NotFoundException } from '@nestjs/common';
import { AdminTicketsService } from './admin-tickets.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminTicketsQueryDto } from './dto/admin.dto';

function query(overrides: Partial<AdminTicketsQueryDto>): AdminTicketsQueryDto {
  return Object.assign(new AdminTicketsQueryDto(), {
    limit: 20,
    offset: 0,
    ...overrides,
  });
}

describe('AdminTicketsService', () => {
  let service: AdminTicketsService;
  let prisma: {
    tickets: {
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      tickets: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    service = new AdminTicketsService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('filters by status and orders created_at desc', async () => {
      prisma.tickets.findMany.mockResolvedValue([{ id: 't1' }]);
      prisma.tickets.count.mockResolvedValue(1);

      const res = await service.list(query({ status: 'In Progress' }));

      const call = (
        prisma.tickets.findMany.mock.calls as unknown[][]
      )[0][0] as {
        where: Record<string, unknown>;
        orderBy: Record<string, string>;
      };
      expect(call.where).toEqual({ status: 'In Progress' });
      expect(call.orderBy).toEqual({ created_at: 'desc' });
      expect(res).toEqual({
        items: [{ id: 't1' }],
        total: 1,
        limit: 20,
        offset: 0,
      });
    });
  });

  describe('updateStatus', () => {
    it('updates when the row exists', async () => {
      prisma.tickets.updateMany.mockResolvedValue({ count: 1 });
      prisma.tickets.findUnique.mockResolvedValue({
        id: 't1',
        status: 'Closed',
      });

      const res = await service.updateStatus('t1', { status: 'Closed' });

      expect(prisma.tickets.updateMany).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { status: 'Closed' },
      });
      expect(res).toEqual({ id: 't1', status: 'Closed' });
    });

    it('404s when missing', async () => {
      prisma.tickets.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.updateStatus('missing', { status: 'Open' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
