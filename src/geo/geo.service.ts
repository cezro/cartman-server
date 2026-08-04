import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { GeoPlace } from './dto/geo.dto';
import type { Geocoder } from './geocoder';
import { GeoCache, forwardCacheKey, reverseCacheKey } from './geo-cache';

/** DI token for the active geocoding backend. Null when none is configured. */
export const GEOCODER = 'GEOCODER';

/**
 * Server-side geocoding proxy.
 *
 * The app never talks to the geocoding provider directly, for four reasons:
 *
 * 1. **The token never ships in the APK.** A token in a client binary is
 *    trivially extractable and someone else can burn the quota.
 * 2. **Caching.** Query→result is highly repeatable, and the cache is what
 *    keeps this inside the free tier (see GeoCache).
 * 3. **Rate limiting.** The global UserOrIpThrottlerGuard already applies.
 * 4. **Provider portability.** Swapping providers is a server deploy, not an
 *    app-store release — which is why the response shape below is ours, not
 *    the upstream's.
 *
 * Tiles deliberately do NOT go through here: dozens of requests per map pan,
 * latency-sensitive, and a CDN is the entire value. Only geocoding is proxied.
 */
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);

  private readonly forwardCache = new GeoCache<GeoPlace[]>();
  private readonly reverseCache = new GeoCache<GeoPlace | null>();

  constructor(
    @Optional() @Inject(GEOCODER) private readonly geocoder: Geocoder | null,
  ) {
    if (!this.geocoder) {
      this.logger.warn(
        'No geocoding provider configured (MAPBOX_TOKEN unset) — /geo/* will ' +
          'return empty results and the app will fall back to manual pin-drop.',
      );
    }
  }

  /**
   * Forward geocode for type-ahead.
   *
   * **Fail-soft is a hard requirement**: any upstream error, timeout, or
   * missing configuration resolves to an empty list, never a thrown error. The
   * address form must degrade to manual pin-drop rather than becoming
   * unusable — a customer who cannot save an address cannot order at all, so a
   * broken geocoder must never be able to take checkout down with it.
   */
  async search(params: {
    q: string;
    limit: number;
    lat?: number;
    lng?: number;
  }): Promise<{ results: GeoPlace[] }> {
    // A lone lat or lng is meaningless as a proximity bias; require the pair.
    const proximity =
      typeof params.lat === 'number' && typeof params.lng === 'number'
        ? { lat: params.lat, lng: params.lng }
        : undefined;

    const key = forwardCacheKey({
      q: params.q,
      limit: params.limit,
      proximity,
    });
    const cached = this.forwardCache.get(key);
    if (cached) return { results: cached };

    if (!this.geocoder) return { results: [] };

    try {
      const results = await this.geocoder.forward({
        q: params.q,
        limit: params.limit,
        proximity,
      });
      this.forwardCache.set(key, results);
      return { results };
    } catch (err) {
      this.logUpstreamFailure('search', err);
      // Deliberately not cached: a transient upstream blip must not poison the
      // key for the next 24h.
      return { results: [] };
    }
  }

  /**
   * Reverse geocode — coords → address, for "use my location" and map taps.
   * Same fail-soft contract as [search]: a null result means "type it yourself",
   * which is exactly the pre-geocoding behaviour.
   */
  async reverse(params: {
    lat: number;
    lng: number;
  }): Promise<{ result: GeoPlace | null }> {
    const key = reverseCacheKey(params);
    const cached = this.reverseCache.get(key);
    if (cached !== undefined) return { result: cached };

    if (!this.geocoder) return { result: null };

    try {
      const result = await this.geocoder.reverse(params);
      this.reverseCache.set(key, result);
      return { result };
    } catch (err) {
      this.logUpstreamFailure('reverse', err);
      return { result: null };
    }
  }



  /**
   * Cache hit rates, for answering "is the cache earning its keep" without
   * adding a metrics dependency. Surfaced on the admin health route.
   */
  cacheStats(): {
    provider: string | null;
    forward: ReturnType<GeoCache<GeoPlace[]>['stats']>;
    reverse: ReturnType<GeoCache<GeoPlace | null>['stats']>;
  } {
    return {
      provider: this.geocoder?.name ?? null,
      forward: this.forwardCache.stats(),
      reverse: this.reverseCache.stats(),
    };
  }

  private logUpstreamFailure(op: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    // warn, not error: this path is expected to happen occasionally and is
    // handled. Paging on it would be noise.
    this.logger.warn(`Geocoding ${op} failed, returning empty: ${message}`);
  }
}
