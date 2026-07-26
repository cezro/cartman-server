/**
 * Bounded, TTL'd in-memory cache for geocoding results.
 *
 * This is the **cost control**, not an optimisation. Geocoding queries are
 * highly repeatable — every customer in the same town types the same handful of
 * barangays — so a cache turns a per-keystroke billable API into a mostly-free
 * one. Treat removing it as a billing change.
 *
 * In-memory (per-instance) is deliberate for now: the server runs as a single
 * Render instance, addresses are near-static, and a shared Redis would be new
 * paid infra for a cache whose miss penalty is one upstream call. If the app
 * ever scales past one instance, promote this to a shared store — the interface
 * is small enough that it stays a drop-in.
 *
 * Eviction is LRU by insertion/refresh order, which `Map` gives us for free:
 * its iteration order is insertion order, so the first key is the oldest and
 * re-setting a key moves it to the end.
 */
export class GeoCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  private hits = 0;
  private misses = 0;

  constructor(
    private readonly maxEntries = 500,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    /** Injectable clock so TTL expiry is testable without real waiting. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      // Expired: drop it and report a miss, so a stale entry never counts as a
      // hit in the ratio we use to judge whether the cache is earning its keep.
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh recency — delete then re-set moves the key to the end of Map's
    // insertion order, which is what makes the eviction below LRU rather than
    // plain FIFO.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    // Delete first so an existing key is re-inserted at the end rather than
    // updated in place (which would leave it at its old, stale position).
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Observability for the "is the cache actually working" question. */
  stats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.entries.size,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }
}

/**
 * Builds the cache key for a forward search.
 *
 * Normalisation is what makes the cache effective: "SM City", "sm city  " and
 * "SM  City" are one entry, not three. Proximity is rounded to ~1km (2 decimal
 * places) because a metre-accurate GPS fix would make every request a unique
 * key and the cache would never hit — the whole point is that everyone standing
 * in the same town shares a bucket.
 */
export function forwardCacheKey(params: {
  q: string;
  limit: number;
  proximity?: { lat: number; lng: number };
}): string {
  const q = params.q.trim().toLowerCase().replace(/\s+/g, ' ');
  const prox = params.proximity
    ? `${params.proximity.lat.toFixed(2)},${params.proximity.lng.toFixed(2)}`
    : 'none';
  return `f:${q}|${params.limit}|${prox}`;
}

/**
 * Cache key for a reverse lookup. Rounded to ~11m (4 dp) — finer than the
 * forward-search proximity bucket because the answer here *is* the specific
 * point, but still coarse enough that two taps on the same building share an
 * entry.
 */
export function reverseCacheKey(params: { lat: number; lng: number }): string {
  return `r:${params.lat.toFixed(4)},${params.lng.toFixed(4)}`;
}
