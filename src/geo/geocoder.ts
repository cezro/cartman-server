import { Logger } from '@nestjs/common';
import type { GeoPlace } from './dto/geo.dto';

/** Every upstream call is pinned to the Philippines. Non-negotiable — without
 * a country filter the results are unusable for a single-country delivery app
 * (a barangay name search returns matches worldwide). */
export const GEO_COUNTRY = 'ph';

/** Upstream timeout. Type-ahead is useless if it resolves after the user has
 * already given up and dropped a pin by hand. */
export const GEO_TIMEOUT_MS = 4000;

/**
 * A geocoding backend. Implementations translate the provider's wire format
 * into [GeoPlace]s and are the ONLY place a provider's schema is known.
 *
 * Implementations must not swallow errors — GeoService owns the fail-soft
 * policy (see its docs) and needs to see the throw in order to log it.
 */
export interface Geocoder {
  /** Human-readable name, used in logs and the health payload. */
  readonly name: string;

  forward(params: {
    q: string;
    limit: number;
    proximity?: { lat: number; lng: number };
  }): Promise<GeoPlace[]>;

  reverse(params: { lat: number; lng: number }): Promise<GeoPlace | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapbox Geocoding v6
// ─────────────────────────────────────────────────────────────────────────────

/** The slice of Mapbox's v6 feature object we actually read. */
interface MapboxV6Feature {
  properties?: {
    name?: string;
    place_formatted?: string;
    full_address?: string;
    coordinates?: { longitude?: number; latitude?: number };
  };
}

interface MapboxV6Response {
  features?: MapboxV6Feature[];
}

/**
 * Mapbox Geocoding v6.
 *
 * Uses a **secret** (`sk.*`) token that lives only in the server environment —
 * never in `schema.prisma`, never in the APK. This is a different token from
 * the app's public tile token; issue two.
 */
export class MapboxGeocoder implements Geocoder {
  readonly name = 'mapbox';

  private readonly logger = new Logger(MapboxGeocoder.name);

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async forward(params: {
    q: string;
    limit: number;
    proximity?: { lat: number; lng: number };
  }): Promise<GeoPlace[]> {
    const url = new URL('https://api.mapbox.com/search/geocode/v6/forward');
    url.searchParams.set('q', params.q);
    url.searchParams.set('limit', String(params.limit));
    url.searchParams.set('country', GEO_COUNTRY);
    url.searchParams.set('access_token', this.token);
    if (params.proximity) {
      // Mapbox takes lng,lat — the reverse of how every other part of this
      // codebase orders a coordinate pair. Getting this backwards silently
      // biases results toward a point in the ocean rather than erroring.
      url.searchParams.set(
        'proximity',
        `${params.proximity.lng},${params.proximity.lat}`,
      );
    }

    const body = await this.get(url);
    return (body.features ?? [])
      .map((f) => toPlace(f))
      .filter((p): p is GeoPlace => p !== null);
  }

  async reverse(params: {
    lat: number;
    lng: number;
  }): Promise<GeoPlace | null> {
    const url = new URL('https://api.mapbox.com/search/geocode/v6/reverse');
    url.searchParams.set('longitude', String(params.lng));
    url.searchParams.set('latitude', String(params.lat));
    url.searchParams.set('limit', '1');
    url.searchParams.set('country', GEO_COUNTRY);
    url.searchParams.set('access_token', this.token);

    const body = await this.get(url);
    const first = (body.features ?? [])[0];
    return first ? toPlace(first) : null;
  }

  private async get(url: URL): Promise<MapboxV6Response> {
    const res = await this.fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(GEO_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Never let the token reach a log sink — url.toString() carries it.
      this.logger.warn(
        `Mapbox ${url.pathname} responded ${res.status} ${res.statusText}`,
      );
      throw new Error(`Mapbox responded ${res.status}`);
    }
    return (await res.json()) as MapboxV6Response;
  }
}

/**
 * Maps one Mapbox v6 feature onto our stable shape, or null when it lacks the
 * coordinates that make it usable (a saved address without a pin is
 * undeliverable, so a result we can't pin is worse than no result).
 */
function toPlace(feature: MapboxV6Feature): GeoPlace | null {
  const props = feature.properties;
  const lat = props?.coordinates?.latitude;
  const lng = props?.coordinates?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const label = props?.name?.trim();
  if (!label) return null;

  return {
    label,
    // full_address includes the name; place_formatted is the remainder. Prefer
    // the latter so the two lines don't repeat the same words.
    address:
      props?.place_formatted?.trim() ?? props?.full_address?.trim() ?? '',
    lat,
    lng,
  };
}
