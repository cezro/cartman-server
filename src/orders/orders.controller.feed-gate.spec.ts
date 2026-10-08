import { ForbiddenException } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { FeedService } from './feed.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import type { AuthenticatedUser } from '../auth/jwt.strategy';

/**
 * GET /orders/feed — the approval gate.
 *
 * `20260803000200_rider_verification_gate.sql` put `is_verified` on the RLS
 * feed policy and on the `accept_order` RPC, and its header says why: "An
 * unapproved rider could take a live order and collect the customer's COD
 * cash."
 *
 * It did not put the check on this route. This route is the one the rider app
 * calls (`GET /orders/feed` in supabase_repositories.dart), and it reads
 * `orders` through Prisma on a privileged connection where RLS does not apply
 * — so the gate that migration installed never covered the live path. The only
 * thing enforcing it was `_PendingVerificationView` in the Flutter app: a
 * client enforcing a server rule, one curl away from nothing.
 *
 * These tests exist so the gate cannot quietly come off again.
 */
describe('OrdersController — feed approval gate', () => {
  let controller: OrdersController;
  let prisma: { riders: { findUnique: jest.Mock } };
  let ledgerService: { getNetCash: jest.Mock };
  let feedService: { rankedFeed: jest.Mock };

  const rider = { id: 'rider-1' } as AuthenticatedUser;

  beforeEach(() => {
    prisma = { riders: { findUnique: jest.fn() } };
    ledgerService = { getNetCash: jest.fn().mockResolvedValue(0n) };
    feedService = { rankedFeed: jest.fn().mockResolvedValue([]) };

    controller = new OrdersController(
      {} as unknown as OrdersService,
      feedService as unknown as FeedService,
      prisma as unknown as PrismaService,
      ledgerService as unknown as LedgerService,
    );
  });

  it('refuses an unapproved rider, and never reaches the feed', async () => {
    prisma.riders.findUnique.mockResolvedValue({
      id: 'rider-1',
      is_active: true,
      is_verified: false,
    });

    await expect(controller.getFeed(rider)).rejects.toThrow(ForbiddenException);
    await expect(controller.getFeed(rider)).rejects.toThrow(
      /still being reviewed/,
    );
    expect(feedService.rankedFeed).not.toHaveBeenCalled();
  });

  it('checks approval before duty', async () => {
    // An unapproved rider who is also off duty should be told the thing that
    // actually blocks them. "Go on duty" would send them to a switch that
    // changes nothing.
    prisma.riders.findUnique.mockResolvedValue({
      id: 'rider-1',
      is_active: false,
      is_verified: false,
    });

    await expect(controller.getFeed(rider)).rejects.toThrow(
      /still being reviewed/,
    );
  });

  it('checks approval before the wallet lookup', async () => {
    // Cheap-first ordering: an unapproved rider should not cost a ledger
    // aggregate on every poll.
    prisma.riders.findUnique.mockResolvedValue({
      id: 'rider-1',
      is_active: true,
      is_verified: false,
    });

    await expect(controller.getFeed(rider)).rejects.toThrow();
    expect(ledgerService.getNetCash).not.toHaveBeenCalled();
  });

  it('refuses when there is no rider row at all', async () => {
    prisma.riders.findUnique.mockResolvedValue(null);

    await expect(controller.getFeed(rider)).rejects.toThrow(
      /still being reviewed/,
    );
  });

  it('still refuses an approved rider who is off duty', async () => {
    prisma.riders.findUnique.mockResolvedValue({
      id: 'rider-1',
      is_active: false,
      is_verified: true,
    });

    await expect(controller.getFeed(rider)).rejects.toThrow(/Go on duty/);
  });

  it('still refuses an approved rider whose wallet is locked', async () => {
    prisma.riders.findUnique.mockResolvedValue({
      id: 'rider-1',
      is_active: true,
      is_verified: true,
    });
    ledgerService.getNetCash.mockResolvedValue(-200000n);

    await expect(controller.getFeed(rider)).rejects.toThrow(/Wallet locked/);
  });

  it('serves the feed to an approved, on-duty, settled rider', async () => {
    prisma.riders.findUnique.mockResolvedValue({
      id: 'rider-1',
      is_active: true,
      is_verified: true,
      vehicle: 'tricycle',
    });

    await controller.getFeed(rider, '10.7', '122.5');

    // The vehicle rides along so tricycle-only orders reach tricycles only.
    expect(feedService.rankedFeed).toHaveBeenCalledWith(
      'rider-1',
      10.7,
      122.5,
      'tricycle',
    );
  });
});
