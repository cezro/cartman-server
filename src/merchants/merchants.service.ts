import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

function serializeMenuItem<T extends Record<string, any>>(item: T): T {
  const out: Record<string, any> = { ...item };
  if (typeof out.price === 'bigint') {
    out.price = Number(out.price);
  }
  return out as T;
}

@Injectable()
export class MerchantsService {
  constructor(private readonly prisma: PrismaService) {}

  async createMerchant(data: any) {
    return this.prisma.merchants.create({ data });
  }

  async updateMerchantStatus(merchantId: string, isOpen: boolean) {
    return this.prisma.merchants.update({
      where: { id: merchantId },
      data: { is_open: isOpen },
    });
  }

  async addMenuItem(merchantId: string, data: any) {
    const item = await this.prisma.menu_items.create({
      data: {
        merchant_id: merchantId,
        ...data,
      },
    });
    return serializeMenuItem(item);
  }

  async getMenuItems(merchantId: string) {
    const items = await this.prisma.menu_items.findMany({
      where: { merchant_id: merchantId },
    });
    return items.map(serializeMenuItem);
  }

  async updateMenuItem(merchantId: string, itemId: string, data: any) {
    const item = await this.prisma.menu_items.update({
      where: { id: itemId, merchant_id: merchantId },
      data,
    });
    return serializeMenuItem(item);
  }

  async toggleStock(merchantId: string, itemId: string, inStock: boolean) {
    const item = await this.prisma.menu_items.update({
      where: { id: itemId, merchant_id: merchantId },
      data: { in_stock: inStock },
    });
    return serializeMenuItem(item);
  }

  async deleteMenuItem(merchantId: string, itemId: string) {
    return this.prisma.menu_items.delete({
      where: { id: itemId, merchant_id: merchantId },
    });
  }
}
