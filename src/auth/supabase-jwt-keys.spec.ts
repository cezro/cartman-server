import { generateKeyPairSync } from 'crypto';
import { SupabaseJwtKeys } from './supabase-jwt-keys';

function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** A raw JWT whose header is real; payload/signature are irrelevant to key
 *  selection (only the header is decoded). */
function tokenWithHeader(header: Record<string, unknown>): string {
  return `${b64url(header)}.${b64url({ sub: 'u1' })}.sig`;
}

function makeEs256Jwk(kid: string): Record<string, unknown> {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256' };
}

describe('SupabaseJwtKeys', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the legacy HS256 secret without touching the network', async () => {
    const keys = new SupabaseJwtKeys(
      'https://proj.supabase.co',
      'legacy-secret',
    );

    const key = await keys.keyFor(
      tokenWithHeader({ alg: 'HS256', typ: 'JWT' }),
    );

    expect(key).toBe('legacy-secret');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves an ES256 kid against the project JWKS and returns a PEM public key', async () => {
    const jwk = makeEs256Jwk('kid-1');
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ keys: [jwk] }),
    });
    const keys = new SupabaseJwtKeys('https://proj.supabase.co', 'unused');

    const key = await keys.keyFor(
      tokenWithHeader({ alg: 'ES256', kid: 'kid-1', typ: 'JWT' }),
    );

    expect(key).toContain('-----BEGIN PUBLIC KEY-----');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://proj.supabase.co/auth/v1/.well-known/jwks.json',
    );
  });

  it('caches the JWKS — a second token with the same kid does not refetch', async () => {
    const jwk = makeEs256Jwk('kid-1');
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ keys: [jwk] }),
    });
    const keys = new SupabaseJwtKeys('https://proj.supabase.co', 'unused');

    await keys.keyFor(tokenWithHeader({ alg: 'ES256', kid: 'kid-1' }));
    await keys.keyFor(tokenWithHeader({ alg: 'ES256', kid: 'kid-1' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown kid with a clear error (after a refetch attempt)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ keys: [makeEs256Jwk('other-kid')] }),
    });
    const keys = new SupabaseJwtKeys('https://proj.supabase.co', 'unused');

    await expect(
      keys.keyFor(tokenWithHeader({ alg: 'ES256', kid: 'missing-kid' })),
    ).rejects.toThrow(/missing-kid/);
  });

  it('fails with a clear message when SUPABASE_URL is absent for an ES256 token', async () => {
    const keys = new SupabaseJwtKeys(undefined, 'legacy-secret');

    await expect(
      keys.keyFor(tokenWithHeader({ alg: 'ES256', kid: 'kid-1' })),
    ).rejects.toThrow(/SUPABASE_URL/);
  });
});
