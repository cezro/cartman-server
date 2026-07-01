import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
    return this.prisma.menu_items.create({
      data: {
        merchant_id: merchantId,
        ...data,
      },
    });
  }

  async getMenuItems(merchantId: string) {
    return this.prisma.menu_items.findMany({
      where: { merchant_id: merchantId },
    });
  }

  async updateMenuItem(merchantId: string, itemId: string, data: any) {
    return this.prisma.menu_items.update({
      where: { id: itemId, merchant_id: merchantId },
      data,
    });
  }

  async toggleStock(merchantId: string, itemId: string, inStock: boolean) {
    return this.prisma.menu_items.update({
      where: { id: itemId, merchant_id: merchantId },
      data: { in_stock: inStock },
    });
  }

  async deleteMenuItem(merchantId: string, itemId: string) {
    return this.prisma.menu_items.delete({
      where: { id: itemId, merchant_id: merchantId },
    });
  }
}
