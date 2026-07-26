import { GeoService } from './geo.service';
import type { Geocoder } from './geocoder';
import type { GeoPlace } from './dto/geo.dto';

const SM_CITY: GeoPlace = {
  label: 'SM City Iloilo',
  address: 'Benigno Aquino Ave, Mandurriao, Iloilo City',
  lat: 10.7128,
  lng: 122.5474,
};

/**
 * Builds a Geocoder double plus direct handles on its two mocks — assertions
 * go through the returned `forward`/`reverse` rather than `geocoder.forward`,
 * which would be an unbound method reference.
 */
function stubGeocoder(
  overrides: {
    forward?: () => Promise<GeoPlace[]>;
    reverse?: () => Promise<GeoPlace | null>;
  } = {},
) {
  const forward = jest.fn(
    overrides.forward ?? (() => Promise.resolve([SM_CITY])),
  );
  const reverse = jest.fn(
    overrides.reverse ?? (() => Promise.resolve<GeoPlace | null>(SM_CITY)),
  );
  const geocoder: Geocoder = { name: 'stub', forward, reverse };
  return { geocoder, forward, reverse };
}

describe('GeoService.search', () => {
  it('returns results from the geocoder', async () => {
    const service = new GeoService(stubGeocoder().geocoder);

    await expect(service.search({ q: 'sm city', limit: 5 })).resolves.toEqual({
      results: [SM_CITY],
    });
  });

  it('serves a repeat query from cache without a second upstream call', async () => {
    // This is the cost control: every cache hit is a billable request avoided.
    const { geocoder, forward } = stubGeocoder();
    const service = new GeoService(geocoder);

    await service.search({ q: 'sm city', limit: 5 });
    await service.search({ q: 'SM  City', limit: 5 });

    expect(forward).toHaveBeenCalledTimes(1);
    expect(service.cacheStats().forward.hits).toBe(1);
  });

  it('passes proximity through only when both lat and lng are present', async () => {
    const { geocoder, forward } = stubGeocoder();
    const service = new GeoService(geocoder);

    await service.search({ q: 'sm city', limit: 5, lat: 10.7, lng: 122.5 });
    expect(forward).toHaveBeenLastCalledWith(
      expect.objectContaining({ proximity: { lat: 10.7, lng: 122.5 } }),
    );

    // A lone lat is meaningless as a bias and must not be forwarded.
    await service.search({ q: 'iloilo city', limit: 5, lat: 10.7 });
    expect(forward).toHaveBeenLastCalledWith(
      expect.objectContaining({ proximity: undefined }),
    );
  });

  it('treats different proximities as different cache entries', async () => {
    const { geocoder, forward } = stubGeocoder();
    const service = new GeoService(geocoder);

    await service.search({ q: 'sm city', limit: 5, lat: 10.71, lng: 122.54 });
    await service.search({ q: 'sm city', limit: 5, lat: 14.58, lng: 120.97 });

    // Same words, different city — Manila must not be served Iloilo's answer.
    expect(forward).toHaveBeenCalledTimes(2);
  });

  it('fails soft to empty results when the upstream errors', async () => {
    const { geocoder } = stubGeocoder({
      forward: () => Promise.reject(new Error('Mapbox responded 500')),
    });
    const service = new GeoService(geocoder);

    // 200 + empty, never a 5xx: the address form must degrade to manual
    // pin-drop, because a customer who cannot save an address cannot order.
    await expect(service.search({ q: 'sm city', limit: 5 })).resolves.toEqual({
      results: [],
    });
  });

  it('does not cache a failure, so the next call retries', async () => {
    let call = 0;
    const { geocoder, forward } = stubGeocoder({
      forward: () => {
        call++;
        return call === 1
          ? Promise.reject(new Error('transient'))
          : Promise.resolve([SM_CITY]);
      },
    });
    const service = new GeoService(geocoder);

    await expect(service.search({ q: 'sm city', limit: 5 })).resolves.toEqual({
      results: [],
    });
    // A transient blip must not poison this key for the full 24h TTL.
    await expect(service.search({ q: 'sm city', limit: 5 })).resolves.toEqual({
      results: [SM_CITY],
    });
    expect(forward).toHaveBeenCalledTimes(2);
  });

  it('returns empty when no geocoder is configured', async () => {
    // Booting without MAPBOX_TOKEN is supported on purpose — a missing map key
    // must not be able to take ordering down.
    const service = new GeoService(null);

    await expect(service.search({ q: 'sm city', limit: 5 })).resolves.toEqual({
      results: [],
    });
    expect(service.cacheStats().provider).toBeNull();
  });
});

describe('GeoService.reverse', () => {
  it('returns the resolved place', async () => {
    const service = new GeoService(stubGeocoder().geocoder);

    await expect(
      service.reverse({ lat: 10.7128, lng: 122.5474 }),
    ).resolves.toEqual({ result: SM_CITY });
  });

  it('caches repeat lookups of the same point', async () => {
    const { geocoder, reverse } = stubGeocoder();
    const service = new GeoService(geocoder);

    await service.reverse({ lat: 10.712831, lng: 122.547412 });
    await service.reverse({ lat: 10.712839, lng: 122.547418 });

    expect(reverse).toHaveBeenCalledTimes(1);
  });

  it('caches a null result too', async () => {
    // `undefined` (absent) and `null` (looked up, nothing there) are different
    // states — a cached null must still count as a hit, or every tap on open
    // water re-bills the upstream.
    const { geocoder, reverse } = stubGeocoder({
      reverse: () => Promise.resolve(null),
    });
    const service = new GeoService(geocoder);

    await service.reverse({ lat: 0, lng: 0 });
    await service.reverse({ lat: 0, lng: 0 });

    expect(reverse).toHaveBeenCalledTimes(1);
    expect(service.cacheStats().reverse.hits).toBe(1);
  });

  it('fails soft to null when the upstream errors', async () => {
    const { geocoder } = stubGeocoder({
      reverse: () => Promise.reject(new Error('timeout')),
    });
    const service = new GeoService(geocoder);

    await expect(service.reverse({ lat: 10.7, lng: 122.5 })).resolves.toEqual({
      result: null,
    });
  });

  it('returns null when no geocoder is configured', async () => {
    const service = new GeoService(null);

    await expect(service.reverse({ lat: 10.7, lng: 122.5 })).resolves.toEqual({
      result: null,
    });
  });
});
