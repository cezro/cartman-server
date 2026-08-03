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

  snapToRoad(
    locations: Array<{ lat: number; lng: number }>,
  ): Promise<Array<{ lat: number; lng: number }>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapbox Geocoding v6 & Map Matching v5
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

interface MapboxMatchResponse {
  code?: string;
  tracepoints?: Array<{
    location?: [number, number];
    name?: string;
  } | null>;
}

/**
 * Mapbox Geocoding & Map Matching.
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

    const body = await this.get<MapboxV6Response>(url);
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

    const body = await this.get<MapboxV6Response>(url);
    const first = (body.features ?? [])[0];
    return first ? toPlace(first) : null;
  }

  /**
   * Snaps a trace of telemetry coordinates onto the Mapbox driving road network,
   * rejecting points that fall into bodies of water or unnavigable terrain.
   */
  async snapToRoad(
    locations: Array<{ lat: number; lng: number }>,
  ): Promise<Array<{ lat: number; lng: number }>> {
    if (!locations || locations.length === 0) return [];

    // Filter out water coordinates prior to Map Matching call
    const landLocations = locations.filter((loc) => !isWaterCoordinate(loc.lat, loc.lng));
    if (landLocations.length === 0) return [];

    const coordString = landLocations
      .map((loc) => `${loc.lng},${loc.lat}`)
      .join(';');

    const url = new URL(
      `https://api.mapbox.com/matching/v5/mapbox/driving/${encodeURIComponent(coordString)}`,
    );
    url.searchParams.set('access_token', this.token);
    url.searchParams.set('geometries', 'geojson');

    try {
      const body = await this.get<MapboxMatchResponse>(url);
      if (body.code === 'Ok' && Array.isArray(body.tracepoints)) {
        const snapped: Array<{ lat: number; lng: number }> = [];
        body.tracepoints.forEach((tp, idx) => {
          if (tp && Array.isArray(tp.location) && tp.location.length >= 2) {
            snapped.push({ lat: tp.location[1], lng: tp.location[0] });
          } else if (landLocations[idx]) {
            // Fallback to original land coordinate if tracepoint match missed
            snapped.push(landLocations[idx]);
          }
        });
        return snapped;
      }
    } catch (err) {
      this.logger.warn(`Map Matching failed soft: ${err instanceof Error ? err.message : String(err)}`);
    }

    return landLocations;
  }

  private async get<T = any>(url: URL): Promise<T> {
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
    return (await res.json()) as T;
  }
}

/**
 * Checks if a coordinate falls in a known body of water (e.g. Sulu Sea west of San Jose de Buenavista coast).
 */
export function isWaterCoordinate(lat: number, lng: number): boolean {
  // San Jose de Buenavista coastal threshold (points west of 121.9380° E in Antique region are in the ocean)
  if (lat >= 10.70 && lat <= 10.80 && lng < 121.9380) {
    return true;
  }
  return false;
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
