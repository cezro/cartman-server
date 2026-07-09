import { AdminConfigService } from './admin-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateConfigDto } from './dto/admin.dto';

const ROW = {
  id: 1,
  base_rate: 39,
  base_radius: 2,
  surcharge_per_km: 15,
  strike_limit: 3,
  auto_assign: true,
  pro_exposure_multiplier: 2,
  allow_ads: true,
  updated_at: new Date('2026-07-09T00:00:00Z'),
};

describe('AdminConfigService', () => {
  let service: AdminConfigService;
  let prisma: {
    global_config: {
      findUnique: jest.Mock;
      create: jest.Mock;
      upsert: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      global_config: {
        findUnique: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
      },
    };
    service = new AdminConfigService(prisma as unknown as PrismaService);
  });

  describe('get', () => {
    it('returns the existing singleton with Decimal fields as Number', async () => {
      prisma.global_config.findUnique.mockResolvedValue(ROW);

      const res = await service.get();

      expect(res.id).toBe(1);
      expect(res.base_rate).toBe(39);
      expect(typeof res.base_rate).toBe('number');
      expect(prisma.global_config.create).not.toHaveBeenCalled();
    });

    it('creates the singleton (id=1) when absent', async () => {
      prisma.global_config.findUnique.mockResolvedValue(null);
      prisma.global_config.create.mockResolvedValue(ROW);

      const res = await service.get();

      expect(prisma.global_config.create.mock.calls[0][0]).toEqual({
        data: { id: 1 },
      });
      expect(res.id).toBe(1);
    });
  });

  describe('update', () => {
    it('upserts id=1 mapping camelCase → snake_case, only provided fields', async () => {
      const body: UpdateConfigDto = {
        pricingConfig: { baseRate: 45, surchargePerKm: 20 },
        riderConfig: { autoAssign: false },
        merchantConfig: { allowAds: false },
      };
      prisma.global_config.upsert.mockResolvedValue({
        ...ROW,
        base_rate: 45,
        surcharge_per_km: 20,
        auto_assign: false,
        allow_ads: false,
      });

      const res = await service.update(body);

      const call = prisma.global_config.upsert.mock.calls[0][0] as {
        where: { id: number };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
      expect(call.where).toEqual({ id: 1 });
      expect(call.update).toEqual({
        base_rate: 45,
        surcharge_per_km: 20,
        auto_assign: false,
        allow_ads: false,
      });
      expect(call.create).toEqual({
        id: 1,
        base_rate: 45,
        surcharge_per_km: 20,
        auto_assign: false,
        allow_ads: false,
      });
      // baseRadius / strikeLimit / proExposureMultiplier were not supplied →
      // not present in the mapped data.
      expect(call.update).not.toHaveProperty('base_radius');
      expect(res.base_rate).toBe(45);
      expect(res.auto_assign).toBe(false);
    });

    it('handles an empty body (no blocks) as a no-op upsert', async () => {
      prisma.global_config.upsert.mockResolvedValue(ROW);

      await service.update({});

      const call = prisma.global_config.upsert.mock.calls[0][0] as {
        update: Record<string, unknown>;
        create: Record<string, unknown>;
      };
      expect(call.update).toEqual({});
      expect(call.create).toEqual({ id: 1 });
    });
  });
});
