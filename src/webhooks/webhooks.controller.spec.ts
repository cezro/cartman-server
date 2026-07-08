import { UnauthorizedException } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

describe('WebhooksController — secret check', () => {
  let controller: WebhooksController;
  let service: { handleOrderWebhook: jest.Mock };
  const originalSecret = process.env.SUPABASE_WEBHOOK_SECRET;

  beforeEach(() => {
    service = {
      handleOrderWebhook: jest.fn().mockResolvedValue({ success: true }),
    };
    controller = new WebhooksController(service as unknown as WebhooksService);
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.SUPABASE_WEBHOOK_SECRET;
    } else {
      process.env.SUPABASE_WEBHOOK_SECRET = originalSecret;
    }
  });

  it('accepts the request and forwards the payload when the header matches the configured secret', async () => {
    process.env.SUPABASE_WEBHOOK_SECRET = 'correct-horse-battery-staple';
    const payload = { type: 'UPDATE', record: { id: 'order-1' } };

    const result = await controller.handleSupabaseWebhook(
      'correct-horse-battery-staple',
      payload,
    );

    expect(service.handleOrderWebhook).toHaveBeenCalledWith(payload);
    expect(result).toEqual({ success: true });
  });

  it('rejects with 401 when the header does not match the configured secret', async () => {
    process.env.SUPABASE_WEBHOOK_SECRET = 'correct-horse-battery-staple';

    await expect(
      controller.handleSupabaseWebhook('wrong-secret', {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.handleOrderWebhook).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the header is missing entirely', async () => {
    process.env.SUPABASE_WEBHOOK_SECRET = 'correct-horse-battery-staple';

    await expect(
      controller.handleSupabaseWebhook(undefined as unknown as string, {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.handleOrderWebhook).not.toHaveBeenCalled();
  });

  it('rejects every request (even with a header) when SUPABASE_WEBHOOK_SECRET is unset — no guessable default', async () => {
    delete process.env.SUPABASE_WEBHOOK_SECRET;

    await expect(
      controller.handleSupabaseWebhook('my-super-secret', {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(service.handleOrderWebhook).not.toHaveBeenCalled();
  });
});
