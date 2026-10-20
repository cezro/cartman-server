import { MapboxGeocoder } from './geocoder';

/** Builds a fetch double that records the URL it was called with. */
function fakeFetch(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
) {
  const calls: string[] = [];
  const impl = jest.fn((url: string | URL | Request) => {
    // Narrowed explicitly rather than String(url): a Request would otherwise
    // stringify to '[object Object]' and the URL assertions below would pass
    // against nothing.
    calls.push(
      url instanceof URL ? url.href : typeof url === 'string' ? url : url.url,
    );
    return Promise.resolve({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: 'stub',
      json: () => Promise.resolve(body),
    } as Response);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const IIexample = {
  features: [
    {
      properties: {
        name: 'SM City Iloilo',
        place_formatted: 'Benigno Aquino Ave, Mandurriao, Iloilo City',
        full_address:
          'SM City Iloilo, Benigno Aquino Ave, Mandurriao, Iloilo City',
        coordinates: { longitude: 122.5474, latitude: 10.7128 },
      },
    },
  ],
};

describe('MapboxGeocoder.forward', () => {
  it('always pins the query to the Philippines', async () => {
    const { impl, calls } = fakeFetch(IIexample);
    await new MapboxGeocoder('sk.test', impl).forward({ q: 'sm', limit: 5 });

    // Non-negotiable: without country=ph the results are unusable for a
    // single-country delivery app.
    expect(new URL(calls[0]).searchParams.get('country')).toBe('ph');
  });

  it('sends proximity as "lng,lat" — the reverse of our own ordering', async () => {
    const { impl, calls } = fakeFetch(IIexample);
    await new MapboxGeocoder('sk.test', impl).forward({
      q: 'sm',
      limit: 5,
      proximity: { lat: 10.7128, lng: 122.5474 },
    });

    // Getting this backwards biases results toward a point in the ocean
    // instead of erroring, so it is worth asserting explicitly.
    expect(new URL(calls[0]).searchParams.get('proximity')).toBe(
      '122.5474,10.7128',
    );
  });

  it('omits proximity when none is supplied', async () => {
    const { impl, calls } = fakeFetch(IIexample);
    await new MapboxGeocoder('sk.test', impl).forward({ q: 'sm', limit: 5 });

    expect(new URL(calls[0]).searchParams.has('proximity')).toBe(false);
  });

  it('forwards q and limit', async () => {
    const { impl, calls } = fakeFetch(IIexample);
    await new MapboxGeocoder('sk.test', impl).forward({
      q: 'sm city',
      limit: 7,
    });

    const params = new URL(calls[0]).searchParams;
    expect(params.get('q')).toBe('sm city');
    expect(params.get('limit')).toBe('7');
  });

  it('maps the upstream feature onto our stable shape', async () => {
    const { impl } = fakeFetch(IIexample);
    const results = await new MapboxGeocoder('sk.test', impl).forward({
      q: 'sm',
      limit: 5,
    });

    // The app depends on exactly these four keys; leaking Mapbox's schema
    // would make a provider swap an app-store release.
    expect(results).toEqual([
      {
        label: 'SM City Iloilo',
        address: 'Benigno Aquino Ave, Mandurriao, Iloilo City',
        lat: 10.7128,
        lng: 122.5474,
      },
    ]);
  });

  it('drops features with no coordinates', async () => {
    // A result we cannot pin is worse than no result: a saved address without
    // coordinates is undeliverable.
    const { impl } = fakeFetch({
      features: [{ properties: { name: 'Nowhere' } }, ...IIexample.features],
    });
    const results = await new MapboxGeocoder('sk.test', impl).forward({
      q: 'sm',
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0].label).toBe('SM City Iloilo');
  });

  it('tolerates an empty or malformed upstream body', async () => {
    const { impl } = fakeFetch({});
    await expect(
      new MapboxGeocoder('sk.test', impl).forward({ q: 'sm', limit: 5 }),
    ).resolves.toEqual([]);
  });

  it('throws on a non-2xx so GeoService can apply its fail-soft policy', async () => {
    const { impl } = fakeFetch({}, { ok: false, status: 500 });

    await expect(
      new MapboxGeocoder('sk.test', impl).forward({ q: 'sm', limit: 5 }),
    ).rejects.toThrow('Mapbox responded 500');
  });

  it('does not put the secret token in the thrown message', async () => {
    const { impl } = fakeFetch({}, { ok: false, status: 401 });

    await expect(
      new MapboxGeocoder('sk.super-secret', impl).forward({
        q: 'sm',
        limit: 5,
      }),
    ).rejects.not.toThrow(/sk\.super-secret/);
  });
});

/** A fetch double that answers each call from its own entry, in order. */
function scriptedFetch(
  responses: Array<{ body: unknown; ok?: boolean; status?: number }>,
) {
  const calls: string[] = [];
  const impl = jest.fn((url: string | URL | Request) => {
    calls.push(
      url instanceof URL ? url.href : typeof url === 'string' ? url : url.url,
    );
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return Promise.resolve({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: 'stub',
      json: () => Promise.resolve(r.body),
    } as Response);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('MapboxGeocoder.forward — landmarks via Search Box', () => {
  // Geocoding v6 is an address geocoder: "SM City Iloilo" came back as five
  // roads named "Iloilo …", never the mall. Type-ahead asks Search Box, which
  // knows places people actually search for, first.
  it('asks the Search Box API first, as type-ahead', async () => {
    const { impl, calls } = fakeFetch(IIexample);
    // limit 1, which the one Search Box result fills: no second call needed.
    await new MapboxGeocoder('sk.test', impl).forward({ q: 'sm', limit: 1 });

    const first = new URL(calls[0]);
    expect(first.pathname).toBe('/search/searchbox/v1/forward');
    expect(first.searchParams.get('auto_complete')).toBe('true');
    expect(calls).toHaveLength(1);
  });

  it('falls back to Geocoding v6 when Search Box fails', async () => {
    const { impl, calls } = scriptedFetch([
      { body: {}, ok: false, status: 403 },
      { body: IIexample },
    ]);
    const results = await new MapboxGeocoder('sk.test', impl).forward({
      q: 'sm',
      limit: 5,
    });

    expect(new URL(calls[1]).pathname).toBe('/search/geocode/v6/forward');
    expect(results).toHaveLength(1);
  });

  it('falls back to Geocoding v6 when Search Box finds nothing', async () => {
    const { impl, calls } = scriptedFetch([
      { body: { features: [] } },
      { body: IIexample },
    ]);
    const results = await new MapboxGeocoder('sk.test', impl).forward({
      q: 'lopez jaena',
      limit: 5,
    });

    expect(new URL(calls[1]).pathname).toBe('/search/geocode/v6/forward');
    expect(results[0].label).toBe('SM City Iloilo');
  });

  it('fills the remaining slots from Geocoding v6, without duplicates', async () => {
    // Search Box ranks shops above a street ("Lopez Jaena St Jaro" → five
    // stores on it); v6 knows the street. A thin Search Box answer gets the
    // streets after it.
    const street = {
      properties: {
        name: 'Lopez Jaena Street',
        place_formatted: 'Jaro, Iloilo City',
        coordinates: { longitude: 122.5631, latitude: 10.7232 },
      },
    };
    const { impl, calls } = scriptedFetch([
      { body: IIexample },
      { body: { features: [IIexample.features[0], street] } },
    ]);
    const results = await new MapboxGeocoder('sk.test', impl).forward({
      q: 'lopez jaena',
      limit: 5,
    });

    expect(calls).toHaveLength(2);
    expect(results.map((r) => r.label)).toEqual([
      'SM City Iloilo',
      'Lopez Jaena Street',
    ]);
  });

  it('keeps the Search Box results when the v6 fill fails', async () => {
    const { impl } = scriptedFetch([
      { body: IIexample },
      { body: {}, ok: false, status: 500 },
    ]);
    const results = await new MapboxGeocoder('sk.test', impl).forward({
      q: 'sm',
      limit: 5,
    });

    expect(results.map((r) => r.label)).toEqual(['SM City Iloilo']);
  });

  it('never returns more than the limit', async () => {
    const many = {
      features: Array.from({ length: 6 }, (_, i) => ({
        properties: {
          name: `Place ${i}`,
          coordinates: { longitude: 122 + i / 100, latitude: 10 },
        },
      })),
    };
    const { impl, calls } = fakeFetch(many);
    const results = await new MapboxGeocoder('sk.test', impl).forward({
      q: 'place',
      limit: 5,
    });

    expect(results).toHaveLength(5);
    expect(calls).toHaveLength(1);
  });

  it('pins the fallback to the Philippines and the same proximity', async () => {
    const { impl, calls } = scriptedFetch([
      { body: { features: [] } },
      { body: IIexample },
    ]);
    await new MapboxGeocoder('sk.test', impl).forward({
      q: 'jaro',
      limit: 5,
      proximity: { lat: 10.7145, lng: 122.5996 },
    });

    const fallback = new URL(calls[1]).searchParams;
    expect(fallback.get('country')).toBe('ph');
    expect(fallback.get('proximity')).toBe('122.5996,10.7145');
  });
});

describe('MapboxGeocoder.reverse', () => {
  it('sends latitude/longitude and country=ph', async () => {
    const { impl, calls } = fakeFetch(IIexample);
    await new MapboxGeocoder('sk.test', impl).reverse({
      lat: 10.7128,
      lng: 122.5474,
    });

    // Reverse stays on Geocoding v6: a pin wants the street address under
    // it, which is what an address geocoder is for.
    expect(new URL(calls[0]).pathname).toBe('/search/geocode/v6/reverse');
    const params = new URL(calls[0]).searchParams;
    expect(params.get('latitude')).toBe('10.7128');
    expect(params.get('longitude')).toBe('122.5474');
    expect(params.get('country')).toBe('ph');
  });

  it('returns the first feature', async () => {
    const { impl } = fakeFetch(IIexample);
    const result = await new MapboxGeocoder('sk.test', impl).reverse({
      lat: 10.7128,
      lng: 122.5474,
    });

    expect(result).toMatchObject({ label: 'SM City Iloilo' });
  });

  it('returns null when the upstream has no match', async () => {
    const { impl } = fakeFetch({ features: [] });
    const result = await new MapboxGeocoder('sk.test', impl).reverse({
      lat: 0,
      lng: 0,
    });

    expect(result).toBeNull();
  });
});
