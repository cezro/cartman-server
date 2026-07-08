import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDeviceTokenDto } from './dto/device-token.dto';
import { serializeProfile } from '../common/serialize-profile';

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string) {
    const profile = await this.prisma.profiles.findUnique({
      where: { id: userId },
    });
    if (!profile) throw new NotFoundException('Profile not found');
    return serializeProfile(profile);
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
    if (!data.is_default) {
      return this.prisma.addresses.create({
        data: {
          user_id: userId,
          ...data,
        },
      });
    }

    // Unsetting the user's other defaults and creating the new default
    // address must be atomic — otherwise a crash between the two calls
    // (or a concurrent request) can leave the user with either zero or
    // two default addresses.
    return this.prisma.$transaction(async (tx) => {
      await tx.addresses.updateMany({
        where: { user_id: userId },
        data: { is_default: false },
      });
      return tx.addresses.create({
        data: {
          user_id: userId,
          ...data,
        },
      });
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
    if (!data.is_default) {
      return this.prisma.addresses.update({
        where: { id: addressId, user_id: userId },
        data,
      });
    }

    // Same atomicity requirement as createAddress: unset the user's other
    // defaults and flip this one to default inside a single transaction.
    return this.prisma.$transaction(async (tx) => {
      await tx.addresses.updateMany({
        where: { user_id: userId, id: { not: addressId } },
        data: { is_default: false },
      });
      return tx.addresses.update({
        where: { id: addressId, user_id: userId },
        data,
      });
    });
  }

  async deleteAddress(userId: string, addressId: string) {
    return this.prisma.addresses.delete({
      where: { id: addressId, user_id: userId },
    });
  }

  /**
   * Upsert a device token for FCM push (C-4.2). The (user_id, token) pair
   * is unique in the schema (@@unique([user_id, token])), so a single
   * Prisma upsert on that compound key handles both "new token" and
   * "re-registering an existing token" without a separate
   * findFirst-then-create/update round trip.
   */
  async registerDeviceToken(userId: string, dto: RegisterDeviceTokenDto) {
    const platform = dto.platform ?? 'android';
    return this.prisma.device_tokens.upsert({
      where: {
        user_id_token: { user_id: userId, token: dto.token },
      },
      create: { user_id: userId, token: dto.token, platform },
      update: { platform },
    });
  }

  /**
   * Remove the caller's own row(s) for a token (sign-out path). Scoped to
   * user_id so one user can never delete another user's registration for
   * the same token value.
   */
  async removeDeviceToken(userId: string, token: string) {
    return this.prisma.device_tokens.deleteMany({
      where: { user_id: userId, token },
    });
  }
}
