import { ProfilesService } from './profiles.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ProfilesService', () => {
  let service: ProfilesService;
  let prisma: {
    profiles: { findUnique: jest.Mock };
    addresses: {
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      delete: jest.Mock;
    };
    device_tokens: {
      findFirst: jest.Mock;
      upsert: jest.Mock;
      deleteMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      profiles: { findUnique: jest.fn() },
      addresses: {
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
      },
      device_tokens: {
        findFirst: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    // Default: $transaction invokes the callback with `prisma` itself acting
    // as the `tx` client, mirroring orders.service.spec.ts's convention.
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      Promise.resolve(cb(prisma)),
    );

    service = new ProfilesService(prisma as unknown as PrismaService);
  });

  describe('getProfile', () => {
    it('serializes BigInt fields to numbers (reproduces the GET /profiles/me 500)', async () => {
      prisma.profiles.findUnique.mockResolvedValue({
        id: 'user-1',
        full_name: 'Juan Dela Cruz',
        cart_points: 1500n,
        wallet_centavos: 250000n,
      });

      const result = await service.getProfile('user-1');

      expect(() => JSON.stringify(result)).not.toThrow();
      expect(result.cart_points).toBe(1500);
      expect(result.wallet_centavos).toBe(250000);
      expect(typeof result.cart_points).toBe('number');
      expect(typeof result.wallet_centavos).toBe('number');
    });

    it('throws NotFoundException when no profile exists', async () => {
      prisma.profiles.findUnique.mockResolvedValue(null);

      await expect(service.getProfile('user-1')).rejects.toThrow(
        'Profile not found',
      );
    });
  });

  describe('createAddress — default-address transaction', () => {
    it('unsets other defaults and creates the new address inside one transaction when is_default is true', async () => {
      prisma.addresses.create.mockResolvedValue({
        id: 'addr-2',
        user_id: 'user-1',
        is_default: true,
      });

      await service.createAddress('user-1', {
        label: 'Home',
        text_address: '123 Main St',
        lat: 10,
        lng: 122,
        is_default: true,
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.addresses.updateMany).toHaveBeenCalledWith({
        where: { user_id: 'user-1' },
        data: { is_default: false },
      });
      expect(prisma.addresses.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            user_id: 'user-1',
            is_default: true,
          }) as Record<string, unknown>,
        }),
      );
    });

    it('does not unset other defaults or open a transaction when is_default is falsy', async () => {
      prisma.addresses.create.mockResolvedValue({ id: 'addr-1' });

      await service.createAddress('user-1', {
        label: 'Work',
        text_address: '456 Side St',
        lat: 10,
        lng: 122,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.addresses.updateMany).not.toHaveBeenCalled();
      expect(prisma.addresses.create).toHaveBeenCalled();
    });
  });

  describe('updateAddress — default-address transaction', () => {
    it('unsets other defaults and updates the address inside one transaction when is_default is true', async () => {
      prisma.addresses.update.mockResolvedValue({
        id: 'addr-1',
        user_id: 'user-1',
        is_default: true,
      });

      await service.updateAddress('user-1', 'addr-1', { is_default: true });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.addresses.updateMany).toHaveBeenCalledWith({
        where: { user_id: 'user-1', id: { not: 'addr-1' } },
        data: { is_default: false },
      });
      expect(prisma.addresses.update).toHaveBeenCalledWith({
        where: { id: 'addr-1', user_id: 'user-1' },
        data: { is_default: true },
      });
    });

    it('does not touch other addresses when is_default is not part of the update', async () => {
      prisma.addresses.update.mockResolvedValue({ id: 'addr-1' });

      await service.updateAddress('user-1', 'addr-1', { label: 'New label' });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.addresses.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('registerDeviceToken', () => {
    it('creates a row for a new (user_id, token) pair', async () => {
      prisma.device_tokens.upsert.mockResolvedValue({
        id: 'dt-1',
        user_id: 'user-1',
        token: 'tok-abc',
        platform: 'android',
      });

      const result = await service.registerDeviceToken('user-1', {
        token: 'tok-abc',
        platform: 'android',
      });

      expect(prisma.device_tokens.upsert).toHaveBeenCalledWith({
        where: {
          user_id_token: { user_id: 'user-1', token: 'tok-abc' },
        },
        create: { user_id: 'user-1', token: 'tok-abc', platform: 'android' },
        update: { platform: 'android' },
      });
      expect(result).toEqual(
        expect.objectContaining({ id: 'dt-1', token: 'tok-abc' }),
      );
    });

    it('re-registering the same token updates rather than duplicating', async () => {
      prisma.device_tokens.upsert.mockResolvedValue({
        id: 'dt-1',
        user_id: 'user-1',
        token: 'tok-abc',
        platform: 'ios',
      });

      await service.registerDeviceToken('user-1', {
        token: 'tok-abc',
        platform: 'ios',
      });

      // Single upsert call relying on the @@unique([user_id, token])
      // constraint — no separate findFirst-then-create/update round trip
      // is needed because Prisma's compound unique input covers it.
      expect(prisma.device_tokens.upsert).toHaveBeenCalledTimes(1);
    });

    it('takes the token away from any other account first (web-and-platform-10)', async () => {
      prisma.device_tokens.deleteMany.mockResolvedValue({ count: 1 });
      prisma.device_tokens.upsert.mockResolvedValue({ id: 'dt-2' });

      await service.registerDeviceToken('user-b', { token: 'tok-abc' });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.device_tokens.deleteMany).toHaveBeenCalledWith({
        where: { token: 'tok-abc', NOT: { user_id: 'user-b' } },
      });
      expect(
        prisma.device_tokens.deleteMany.mock.invocationCallOrder[0],
      ).toBeLessThan(prisma.device_tokens.upsert.mock.invocationCallOrder[0]);
    });

    it('defaults platform to android when omitted', async () => {
      prisma.device_tokens.upsert.mockResolvedValue({
        id: 'dt-1',
        user_id: 'user-1',
        token: 'tok-xyz',
        platform: 'android',
      });

      await service.registerDeviceToken('user-1', { token: 'tok-xyz' });

      expect(prisma.device_tokens.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            platform: 'android',
          }) as Record<string, unknown>,
        }),
      );
    });
  });

  describe('removeDeviceToken', () => {
    it('deletes only the caller-own row(s) for that token', async () => {
      prisma.device_tokens.deleteMany.mockResolvedValue({ count: 1 });

      await service.removeDeviceToken('user-1', 'tok-abc');

      expect(prisma.device_tokens.deleteMany).toHaveBeenCalledWith({
        where: { user_id: 'user-1', token: 'tok-abc' },
      });
    });
  });
});
