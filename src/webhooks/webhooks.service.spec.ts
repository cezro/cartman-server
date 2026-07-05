import { WebhooksService } from './webhooks.service';

// Current state of FCM fan-out (C-4.2): webhooks.service.ts only *logs* what
// it would send — there is no device_tokens lookup, no firebase-admin (or
// any) SDK call, no rider fan-out on ready_for_pickup, and no wallet-lockout
// exclusion. These tests pin that stub behavior (so a future real
// implementation has a clear "before" baseline) and guard the one thing the
// brief calls out: FCM env vars being absent must never crash the webhook.
describe('WebhooksService.handleOrderWebhook', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('logs an order UPDATE with a status change and always returns success (no throw)', async () => {
    delete process.env.FCM_PROJECT_ID;
    delete process.env.FCM_CLIENT_EMAIL;
    delete process.env.FCM_PRIVATE_KEY;

    const service = new WebhooksService();
    const payload = {
      type: 'UPDATE',
      record: {
        id: 'order-1',
        status: 'ready_for_pickup',
        customer_id: 'cust-1',
        assigned_rider_id: null,
      },
      old_record: {
        id: 'order-1',
        status: 'preparing',
        customer_id: 'cust-1',
        assigned_rider_id: null,
      },
    };

    await expect(service.handleOrderWebhook(payload)).resolves.toEqual({
      success: true,
    });
  });

  it('does not throw for an INSERT payload (no old_record)', async () => {
    const service = new WebhooksService();
    const payload = {
      type: 'INSERT',
      record: { id: 'order-2', status: 'placed', customer_id: 'cust-2' },
      old_record: null,
    };

    await expect(service.handleOrderWebhook(payload)).resolves.toEqual({
      success: true,
    });
  });

  it('does not throw when the payload is missing fields entirely', async () => {
    const service = new WebhooksService();

    await expect(service.handleOrderWebhook({})).resolves.toEqual({
      success: true,
    });
  });

  it('warns and no-ops (still returns success) when FCM env vars are absent, even for a status change with an assigned rider', async () => {
    delete process.env.FCM_PROJECT_ID;
    delete process.env.FCM_CLIENT_EMAIL;
    delete process.env.FCM_PRIVATE_KEY;

    const service = new WebhooksService();
    const warnSpy = jest.spyOn(
      (service as unknown as { logger: { warn: (msg: string) => void } })
        .logger,
      'warn',
    );

    const payload = {
      type: 'UPDATE',
      record: {
        id: 'order-3',
        status: 'in_transit',
        customer_id: 'cust-3',
        assigned_rider_id: 'rider-3',
      },
      old_record: {
        id: 'order-3',
        status: 'picked_up',
        customer_id: 'cust-3',
        assigned_rider_id: 'rider-3',
      },
    };

    await expect(service.handleOrderWebhook(payload)).resolves.toEqual({
      success: true,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('FCM is not configured'),
    );
  });
});
