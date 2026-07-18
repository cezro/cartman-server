import { createPublicKey } from 'crypto';

interface Jwk {
  kid?: string;
  kty: string;
  [k: string]: unknown;
}

/**
 * Resolves the verification key for a Supabase-issued JWT from its header.
 *
 * Newer Supabase projects sign access tokens with asymmetric keys (ES256 +
 * a `kid`, discovered 2026-07-18 when every live bearer call 401'd) while
 * older projects — and this repo's test fixtures — use the legacy HS256
 * project secret. Both must verify:
 *  - HS256 → SUPABASE_JWT_SECRET, no network.
 *  - ES256/RS256 → the project's JWKS
 *    (`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`), fetched once and
 *    cached; an unknown `kid` triggers ONE refetch (key rotation) before
 *    failing.
 */
export class SupabaseJwtKeys {
  private pemByKid = new Map<string, string>();
  private fetched = false;

  constructor(
    private readonly supabaseUrl: string | undefined,
    private readonly hsSecret: string,
  ) {}

  async keyFor(rawJwt: string): Promise<string> {
    const header = this.decodeHeader(rawJwt);
    const alg = typeof header.alg === 'string' ? header.alg : '';

    if (alg.startsWith('HS')) return this.hsSecret;

    if (!this.supabaseUrl) {
      throw new Error(
        'SUPABASE_URL must be set to verify asymmetric (ES256) Supabase tokens',
      );
    }

    const kid = typeof header.kid === 'string' ? header.kid : '';
    if (!this.fetched || !this.pemByKid.has(kid)) {
      await this.fetchJwks();
    }
    const pem = this.pemByKid.get(kid);
    if (!pem) {
      throw new Error(`No JWKS key matches token kid "${kid}"`);
    }
    return pem;
  }

  private decodeHeader(rawJwt: string): Record<string, unknown> {
    try {
      const headerB64 = rawJwt.split('.')[0];
      return JSON.parse(
        Buffer.from(headerB64, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
    } catch {
      throw new Error('Malformed JWT header');
    }
  }

  private async fetchJwks(): Promise<void> {
    const url = `${this.supabaseUrl}/auth/v1/.well-known/jwks.json`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`JWKS fetch failed (${res.status}) from ${url}`);
    }
    const body = (await res.json()) as { keys?: Jwk[] };
    const next = new Map<string, string>();
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid) continue;
      try {
        const pem = createPublicKey({ key: jwk, format: 'jwk' })
          .export({ type: 'spki', format: 'pem' })
          .toString();
        next.set(jwk.kid, pem);
      } catch {
        // Skip unusable entries rather than failing the whole set.
      }
    }
    this.pemByKid = next;
    this.fetched = true;
  }
}
