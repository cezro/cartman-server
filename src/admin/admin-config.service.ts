import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateConfigDto } from './dto/admin.dto';
import { serializeGlobalConfig } from './serialize-admin';

/**
 * Admin Dashboard V2 — global business configuration (singleton row id=1).
 *
 * STORE-AND-SERVE ONLY: these values are persisted and returned to the admin
 * dashboard, but are NOT (yet) wired into the live delivery-fee / commission
 * / dispatch calculations — that rewiring is out of scope for V2. The runtime
 * pricing constants still live in orders.service.ts. Consumers must not
 * assume a change here takes effect on real orders.
 */
@Injectable()
export class AdminConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async get() {
    // db push does not seed the singleton, so create it on first read.
    let row = await this.prisma.global_config.findUnique({ where: { id: 1 } });
    if (!row) {
      row = await this.prisma.global_config.create({ data: { id: 1 } });
    }
    return serializeGlobalConfig(row);
  }

  async update(body: UpdateConfigDto) {
    const data = this.mapToColumns(body);
    const row = await this.prisma.global_config.upsert({
      where: { id: 1 },
      create: { id: 1, ...data },
      update: data,
    });
    return serializeGlobalConfig(row);
  }

  // Maps the nested camelCase request blocks to the flat snake_case columns,
  // including only fields the caller actually supplied (a partial update).
  private mapToColumns(body: UpdateConfigDto): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    const { pricingConfig, riderConfig, merchantConfig } = body;

    if (pricingConfig?.baseRate !== undefined) {
      data.base_rate = pricingConfig.baseRate;
    }
    if (pricingConfig?.baseRadius !== undefined) {
      data.base_radius = pricingConfig.baseRadius;
    }
    if (pricingConfig?.surchargePerKm !== undefined) {
      data.surcharge_per_km = pricingConfig.surchargePerKm;
    }
    if (riderConfig?.strikeLimit !== undefined) {
      data.strike_limit = riderConfig.strikeLimit;
    }
    if (riderConfig?.autoAssign !== undefined) {
      data.auto_assign = riderConfig.autoAssign;
    }
    if (merchantConfig?.proExposureMultiplier !== undefined) {
      data.pro_exposure_multiplier = merchantConfig.proExposureMultiplier;
    }
    if (merchantConfig?.allowAds !== undefined) {
      data.allow_ads = merchantConfig.allowAds;
    }
    return data;
  }
}
