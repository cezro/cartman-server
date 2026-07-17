import { generateKeyPairSync } from 'node:crypto';
import { FcmService } from './fcm.service';

// FCM HTTP v1 transport (cartman-server-endpoints.md §7). No firebase-admin —
// the OAuth2 service-account exchange and the messages:send call are plain
// fetch, so these tests mock global.fetch and use a locally generated RSA key
// for the JWT-bearer assertion.
describe('FcmService', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.FCM_PROJECT_ID = 'proj-1';
    process.env.FCM_CLIENT_EMAIL = 'svc@proj-1.iam.gserviceaccount.com';
    process.env.FCM_PRIVATE_KEY = privateKey;

    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  it('isConfigured is false when any FCM env var is missing', () => {
    delete process.env.FCM_PRIVATE_KEY;
    expect(new FcmService().isConfigured()).toBe(false);
  });

  it('isConfigured is true when all three FCM env vars are present', () => {
    expect(new FcmService().isConfigured()).toBe(true);
  });

  it('mints an OAuth token via the JWT-bearer grant and caches it', async () => {
    const service = new FcmService();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ access_token: 'at-1', expires_in: 3600 }),
    });

    const token1 = await (
      service as unknown as { getAccessToken: () => Promise<string> }
    ).getAccessToken();
    const token2 = await (
      service as unknown as { getAccessToken: () => Promise<string> }
    ).getAccessToken();

    expect(token1).toBe('at-1');
    expect(token2).toBe('at-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = init.body as string;
    expect(body).toContain(
      'urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer',
    );
    // The assertion must be a signed three-part JWT.
    const assertion = new URLSearchParams(body).get('assertion')!;
    expect(assertion.split('.')).toHaveLength(3);
  });

  it('sends a v1 message and reports ok', async () => {
    const service = new FcmService();
    jest
      .spyOn(
        service as unknown as { getAccessToken: () => Promise<string> },
        'getAccessToken',
      )
      .mockResolvedValue('tok-1');
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ name: 'projects/proj-1/messages/m1' }),
    });

    const result = await service.sendToToken(
      'device-token-1',
      { title: 'Order update', body: 'Your order is on the way' },
      { order_id: 'order-1' },
    );

    expect(result).toEqual({ ok: true, unregistered: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://fcm.googleapis.com/v1/projects/proj-1/messages:send',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok-1',
    );
    const payload = JSON.parse(init.body as string) as {
      message: {
        token: string;
        notification: { title: string };
        data: Record<string, string>;
      };
    };
    expect(payload.message.token).toBe('device-token-1');
    expect(payload.message.notification.title).toBe('Order update');
    expect(payload.message.data.order_id).toBe('order-1');
  });

  it('flags UNREGISTERED tokens so callers can prune them', async () => {
    const service = new FcmService();
    jest
      .spyOn(
        service as unknown as { getAccessToken: () => Promise<string> },
        'getAccessToken',
      )
      .mockResolvedValue('tok-1');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: () =>
        Promise.resolve({
          error: {
            status: 'NOT_FOUND',
            details: [
              {
                '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                errorCode: 'UNREGISTERED',
              },
            ],
          },
        }),
    });

    const result = await service.sendToToken('stale-token', {
      title: 't',
      body: 'b',
    });

    expect(result).toEqual({ ok: false, unregistered: true });
  });

  it('reports a transient failure without flagging the token', async () => {
    const service = new FcmService();
    jest
      .spyOn(
        service as unknown as { getAccessToken: () => Promise<string> },
        'getAccessToken',
      )
      .mockResolvedValue('tok-1');
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { status: 'INTERNAL' } }),
    });

    const result = await service.sendToToken('token-1', {
      title: 't',
      body: 'b',
    });

    expect(result).toEqual({ ok: false, unregistered: false });
  });
});
