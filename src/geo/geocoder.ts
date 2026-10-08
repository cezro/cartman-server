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

/**
 * The slice of a Mapbox feature we actually read. Geocoding v6 and Search Box
 * both put name, place_formatted, full_address and coordinates under
 * `properties`, so one shape serves both.
 */
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

  /**
   * Type-ahead. **Search Box API** first; Geocoding v6 fills what is left.
   *
   * Geocoding v6 is an address geocoder — Mapbox dropped points of interest
   * from Geocoding and points landmark search at Search Box. So "SM City
   * Iloilo" came back as five roads named "Iloilo …" and "Ateneo de Manila"
   * as "Manila": customers search by landmark, and got streets.
   *
   * Search Box has the opposite blind spot: it ranks shops above a street, so
   * "Lopez Jaena St Jaro" is five stores on Lopez Jaena. When it returns fewer
   * than [limit] places, v6 fills the remaining slots (duplicates dropped), so
   * a street or a thin answer still gets its streets.
   *
   * Failure only ever falls back. Search Box erroring (an outage, a token
   * without Search access) is exactly today's v6 search; a v6 fill failing
   * keeps the Search Box results. Only v6 failing *with nothing else to show*
   * throws — that is the case GeoService's fail-soft policy needs to see.
   */
  async forward(params: {
    q: string;
    limit: number;
    proximity?: { lat: number; lng: number };
  }): Promise<GeoPlace[]> {
    let primary: GeoPlace[] = [];
    try {
      const url = this.forwardUrl(
        'https://api.mapbox.com/search/searchbox/v1/forward',
        params,
      );
      // Partial and fuzzy matches — the field is filled one keystroke at a
      // time.
      url.searchParams.set('auto_complete', 'true');
      primary = toPlaces(await this.get(url));
    } catch {
      // A non-2xx is logged by get(); either way v6 is the answer below.
    }
    if (primary.length >= params.limit) return primary.slice(0, params.limit);

    const v6 = this.forwardUrl(
      'https://api.mapbox.com/search/geocode/v6/forward',
      params,
    );
    let fill: GeoPlace[];
    try {
      fill = toPlaces(await this.get(v6));
    } catch (err) {
      if (primary.length === 0) throw err;
      fill = [];
    }
    return dedupePlaces([...primary, ...fill]).slice(0, params.limit);
  }

  /** The parameters both forward endpoints share, set the same way. */
  private forwardUrl(
    endpoint: string,
    params: {
      q: string;
      limit: number;
      proximity?: { lat: number; lng: number };
    },
  ): URL {
    const url = new URL(endpoint);
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
    return url;
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
 * Drops a place already listed: same name, within ~100 m. Search Box and v6
 * often both know "SM City Iloilo", at slightly different coordinates.
 */
function dedupePlaces(places: GeoPlace[]): GeoPlace[] {
  const seen = new Set<string>();
  return places.filter((p) => {
    const key = `${p.label.toLowerCase()}@${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every usable place in a response, in the upstream's ranking order. */
function toPlaces(body: MapboxV6Response): GeoPlace[] {
  return (body.features ?? [])
    .map((f) => toPlace(f))
    .filter((p): p is GeoPlace => p !== null);
}

/**
 * Maps one Mapbox feature onto our stable shape — Search Box and Geocoding v6
 * share the fields read here — or null when it lacks the
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
