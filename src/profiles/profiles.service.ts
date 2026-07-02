import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string) {
    const profile = await this.prisma.profiles.findUnique({
      where: { id: userId },
    });
    if (!profile) throw new NotFoundException('Profile not found');
    return profile;
  }

  async getAddresses(userId: string) {
    return this.prisma.addresses.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
    });
  }

  async createAddress(
    userId: string,
    data: {
      label: string;
      text_address: string;
      lat: number;
      lng: number;
      is_default?: boolean;
    },
  ) {
    if (data.is_default) {
      await this.prisma.addresses.updateMany({
        where: { user_id: userId },
        data: { is_default: false },
      });
    }
    return this.prisma.addresses.create({
      data: {
        user_id: userId,
        ...data,
      },
    });
  }

  async updateAddress(
    userId: string,
    addressId: string,
    data: {
      label?: string;
      text_address?: string;
      lat?: number;
      lng?: number;
      is_default?: boolean;
    },
  ) {
    if (data.is_default) {
      await this.prisma.addresses.updateMany({
        where: { user_id: userId },
        data: { is_default: false },
      });
    }
    return this.prisma.addresses.update({
      where: { id: addressId, user_id: userId },
      data,
    });
  }

  async deleteAddress(userId: string, addressId: string) {
    return this.prisma.addresses.delete({
      where: { id: addressId, user_id: userId },
    });
  }
}
