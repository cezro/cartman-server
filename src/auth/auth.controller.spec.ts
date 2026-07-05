import { AuthController } from './auth.controller';
import { OtpService } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from './jwt.strategy';

describe('AuthController — getMe', () => {
  let controller: AuthController;
  let prisma: {
    profiles: { findUnique: jest.Mock };
  };

  const user: AuthenticatedUser = {
    id: 'user-1',
    role: 'customer',
  };

  beforeEach(() => {
    prisma = {
      profiles: { findUnique: jest.fn() },
    };

    controller = new AuthController(
      {} as OtpService,
      prisma as unknown as PrismaService,
    );
  });

  it('returns a profile whose BigInt fields survive JSON.stringify (reproduces the /auth/me 500)', async () => {
    prisma.profiles.findUnique.mockResolvedValue({
      id: 'user-1',
      full_name: 'Juan Dela Cruz',
      phone: '+639171234567',
      phone_verified: true,
      role: 'rider',
      avatar_url: null,
      membership_tier: 'Bronze',
      cart_points: 1500n,
      wallet_centavos: 250000n,
      created_at: new Date('2026-07-01T00:00:00.000Z'),
      rider: {
        id: 'user-1',
        is_active: true,
        vehicle: 'motorcycle',
        plate_no: 'ABC-123',
        rating: { toString: () => '4.8' }, // Prisma.Decimal-like
        acceptance_rate: { toString: () => '0.95' },
        total_trips: 42,
        broadcast_count: 3,
        avg_duration_secs: 120,
        updated_at: new Date('2026-07-04T00:00:00.000Z'),
      },
    });

    const result = await controller.getMe(user);

    // The bug: JSON.stringify throws "Do not know how to serialize a BigInt"
    // when raw BigInt fields are present. Asserting this doesn't throw is
    // the exact repro for the 500 Nest's default serializer produced.
    expect(() => JSON.stringify(result)).not.toThrow();

    expect(result.cart_points).toBe(1500);
    expect(result.wallet_centavos).toBe(250000);
    expect(typeof result.cart_points).toBe('number');
    expect(typeof result.wallet_centavos).toBe('number');

    // Nested rider relation is untouched — Decimal fields stringify fine.
    expect(result.rider.id).toBe('user-1');
  });

  it('passes through null when no profile is found', async () => {
    prisma.profiles.findUnique.mockResolvedValue(null);

    const result = await controller.getMe(user);

    expect(result).toBeNull();
  });
});
