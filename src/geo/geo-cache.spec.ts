import { GeoCache, forwardCacheKey, reverseCacheKey } from './geo-cache';

describe('GeoCache', () => {
  it('returns a stored value and counts it as a hit', () => {
    const cache = new GeoCache<string>();
    cache.set('k', 'v');

    expect(cache.get('k')).toBe('v');
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 0, hitRate: 1 });
  });

  it('counts an unknown key as a miss', () => {
    const cache = new GeoCache<string>();

    expect(cache.get('nope')).toBeUndefined();
    expect(cache.stats()).toMatchObject({ hits: 0, misses: 1, hitRate: 0 });
  });

  it('expires entries after the TTL and reports them as misses', () => {
    let now = 1_000;
    const cache = new GeoCache<string>(500, 60_000, () => now);
    cache.set('k', 'v');

    now += 59_999;
    expect(cache.get('k')).toBe('v');

    // One tick past the TTL boundary.
    now += 2;
    expect(cache.get('k')).toBeUndefined();
    // A stale entry must never be counted as a hit — that would make the
    // hit-rate we use to judge the cache look better than it is.
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
  });

  it('evicts the least-recently-used entry once past maxEntries', () => {
    const cache = new GeoCache<string>(2);
    cache.set('a', '1');
    cache.set('b', '2');

    // Touch 'a' so 'b' becomes the least-recently-used.
    expect(cache.get('a')).toBe('1');

    cache.set('c', '3');

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1');
    expect(cache.get('c')).toBe('3');
  });

  it('caps size at maxEntries', () => {
    const cache = new GeoCache<string>(3);
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, `v${i}`);

    expect(cache.stats().size).toBe(3);
  });

  it('re-setting an existing key does not grow the cache', () => {
    const cache = new GeoCache<string>(5);
    cache.set('k', 'v1');
    cache.set('k', 'v2');

    expect(cache.stats().size).toBe(1);
    expect(cache.get('k')).toBe('v2');
  });
});

describe('forwardCacheKey', () => {
  it('normalises case and whitespace so equivalent queries share one entry', () => {
    // This normalisation is what makes the cache actually hit — without it
    // every capitalisation variant would be a separate billable lookup.
    const a = forwardCacheKey({ q: 'SM City', limit: 5 });
    const b = forwardCacheKey({ q: '  sm   city ', limit: 5 });

    expect(a).toBe(b);
  });

  it('rounds proximity to ~1km so nearby users share a bucket', () => {
    const a = forwardCacheKey({
      q: 'sm city',
      limit: 5,
      proximity: { lat: 10.71283, lng: 122.54741 },
    });
    const b = forwardCacheKey({
      q: 'sm city',
      limit: 5,
      proximity: { lat: 10.71299, lng: 122.54755 },
    });

    expect(a).toBe(b);
  });

  it('separates different limits and distant proximities', () => {
    const base = { q: 'sm city', limit: 5 };

    expect(forwardCacheKey(base)).not.toBe(
      forwardCacheKey({ ...base, limit: 10 }),
    );
    expect(forwardCacheKey(base)).not.toBe(
      forwardCacheKey({ ...base, proximity: { lat: 14.58, lng: 120.97 } }),
    );
  });
});

describe('reverseCacheKey', () => {
  it('rounds to ~11m so two taps on one building share an entry', () => {
    expect(reverseCacheKey({ lat: 10.712831, lng: 122.547412 })).toBe(
      reverseCacheKey({ lat: 10.712839, lng: 122.547418 }),
    );
  });

  it('keeps genuinely different points apart', () => {
    expect(reverseCacheKey({ lat: 10.7128, lng: 122.5474 })).not.toBe(
      reverseCacheKey({ lat: 10.7228, lng: 122.5474 }),
    );
  });
});
