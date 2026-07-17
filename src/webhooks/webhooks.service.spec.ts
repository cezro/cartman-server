import { WebhooksService } from './webhooks.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { FcmService } from './fcm.service';
import { WALLET_LOCK_FLOOR } from '../orders/orders.service';

// FCM fan-out (cartman-server-endpoints.md §7). WebhooksService owns the
// orchestration — device_tokens lookup, stale-token pruning, customer notify
// on every status change, on-duty rider fan-out (minus wallet-locked riders)
// when an order becomes ready_for_pickup — while FcmService (mocked here) is
// the transport. The webhook must never crash: missing config degrades to a
// warned no-op and send errors are swallowed, per the original brief.
describe('WebhooksService.handleOrderWebhook', () => {
  let prisma: {
    device_tokens: { findMany: jest.Mock; deleteMany: jest.Mock };
    riders: { findMany: jest.Mock };
  };
  let ledger: { getNetCash: jest.Mock };
  let fcm: { isConfigured: jest.Mock; sendToToken: jest.Mock };
  let service: WebhooksService;

  const statusChangePayload = (
    status: string,
    oldStatus: string,
    extra: Record<string, unknown> = {},
  ) => ({
    type: 'UPDATE',
    record: {
      id: 'order-1',
      status,
      customer_id: 'cust-1',
      assigned_rider_id: null,
      ...extra,
    },
    old_record: {
      id: 'order-1',
      status: oldStatus,
      customer_id: 'cust-1',
      assigned_rider_id: null,
    },
  });

  beforeEach(() => {
    prisma = {
      device_tokens: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      riders: { findMany: jest.fn().mockResolvedValue([]) },
    };
    ledger = { getNetCash: jest.fn().mockResolvedValue(0n) };
    fcm = {
      isConfigured: jest.fn().mockReturnValue(true),
      sendToToken: jest
        .fn()
        .mockResolvedValue({ ok: true, unregistered: false }),
    };
    service = new WebhooksService(
      prisma as unknown as PrismaService,
      ledger as unknown as LedgerService,
      fcm as unknown as FcmService,
    );
  });

  it('warns and no-ops (still returns success) when FCM is not configured', async () => {
    fcm.isConfigured.mockReturnValue(false);
    const warnSpy = jest.spyOn(
      (service as unknown as { logger: { warn: (msg: string) => void } })
        .logger,
      'warn',
    );

    await expect(
      service.handleOrderWebhook(
        statusChangePayload('in_transit', 'picked_up'),
      ),
    ).resolves.toEqual({ success: true });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('FCM is not configured'),
    );
    expect(fcm.sendToToken).not.toHaveBeenCalled();
  });

  it('does not throw for an INSERT payload (no old_record)', async () => {
    await expect(
      service.handleOrderWebhook({
        type: 'INSERT',
        record: { id: 'order-2', status: 'pending', customer_id: 'cust-2' },
        old_record: null,
      }),
    ).resolves.toEqual({ success: true });
    expect(fcm.sendToToken).not.toHaveBeenCalled();
  });

  it('does not throw when the payload is missing fields entirely', async () => {
    await expect(service.handleOrderWebhook({})).resolves.toEqual({
      success: true,
    });
  });

  it('sends nothing when the status did not change', async () => {
    await service.handleOrderWebhook(
      statusChangePayload('in_transit', 'in_transit'),
    );

    expect(prisma.device_tokens.findMany).not.toHaveBeenCalled();
    expect(fcm.sendToToken).not.toHaveBeenCalled();
  });

  it("notifies every device token of the order's customer on a status change", async () => {
    prisma.device_tokens.findMany.mockResolvedValue([
      { token: 'tok-a' },
      { token: 'tok-b' },
    ]);

    await service.handleOrderWebhook(
      statusChangePayload('preparing', 'pending'),
    );

    expect(prisma.device_tokens.findMany).toHaveBeenCalledWith({
      where: { user_id: 'cust-1' },
    });
    const sentTokens = fcm.sendToToken.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(sentTokens).toEqual(expect.arrayContaining(['tok-a', 'tok-b']));
  });

  it('prunes tokens FCM reports as unregistered', async () => {
    prisma.device_tokens.findMany.mockResolvedValue([
      { token: 'fresh' },
      { token: 'stale' },
    ]);
    fcm.sendToToken.mockImplementation((token: string) =>
      Promise.resolve(
        token === 'stale'
          ? { ok: false, unregistered: true }
          : { ok: true, unregistered: false },
      ),
    );

    await service.handleOrderWebhook(
      statusChangePayload('preparing', 'pending'),
    );

    expect(prisma.device_tokens.deleteMany).toHaveBeenCalledWith({
      where: { user_id: 'cust-1', token: 'stale' },
    });
    expect(prisma.device_tokens.deleteMany).not.toHaveBeenCalledWith({
      where: { user_id: 'cust-1', token: 'fresh' },
    });
  });

  it('notifies the assigned rider on rider-driven status changes', async () => {
    await service.handleOrderWebhook(
      statusChangePayload('in_transit', 'picked_up', {
        assigned_rider_id: 'rider-9',
      }),
    );

    expect(prisma.device_tokens.findMany).toHaveBeenCalledWith({
      where: { user_id: 'rider-9' },
    });
  });

  it('fans out ready_for_pickup to on-duty riders, excluding wallet-locked ones', async () => {
    prisma.riders.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    ledger.getNetCash.mockImplementation((riderId: string) =>
      Promise.resolve(riderId === 'r2' ? WALLET_LOCK_FLOOR : 0n),
    );

    await service.handleOrderWebhook(
      statusChangePayload('ready_for_pickup', 'preparing'),
    );

    expect(prisma.riders.findMany).toHaveBeenCalledWith({
      where: { is_active: true },
    });
    const lookedUpUsers = prisma.device_tokens.findMany.mock.calls.map(
      (c: unknown[]) => (c[0] as { where: { user_id: string } }).where.user_id,
    );
    expect(lookedUpUsers).toContain('r1');
    expect(lookedUpUsers).not.toContain('r2');
  });

  it('does not fan out to riders for non-ready transitions', async () => {
    await service.handleOrderWebhook(
      statusChangePayload('preparing', 'pending'),
    );

    expect(prisma.riders.findMany).not.toHaveBeenCalled();
  });

  it('still returns success when a send blows up mid-fan-out', async () => {
    prisma.device_tokens.findMany.mockResolvedValue([{ token: 'tok-a' }]);
    fcm.sendToToken.mockRejectedValue(new Error('FCM is down'));

    await expect(
      service.handleOrderWebhook(statusChangePayload('preparing', 'pending')),
    ).resolves.toEqual({ success: true });
  });

  it('still returns success when the DB lookup blows up', async () => {
    prisma.device_tokens.findMany.mockRejectedValue(new Error('db down'));

    await expect(
      service.handleOrderWebhook(statusChangePayload('preparing', 'pending')),
    ).resolves.toEqual({ success: true });
  });
});
