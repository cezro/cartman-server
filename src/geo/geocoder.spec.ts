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

describe('MapboxGeocoder.reverse', () => {
  it('sends latitude/longitude and country=ph', async () => {
    const { impl, calls } = fakeFetch(IIexample);
    await new MapboxGeocoder('sk.test', impl).reverse({
      lat: 10.7128,
      lng: 122.5474,
    });

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
