/**
 * Cache-Control-aware freshness policy for the SW cache.
 *
 * The SW cache is the end user's own private cache, so honoring the
 * origin's `Cache-Control` is both correct HTTP behavior and what
 * upstream tile providers' terms sanction (e.g. Google Map Tiles sends
 * `private, max-age=…` — cacheable here, but only for that long).
 *
 * The Cache API neither expires entries nor records when they were
 * stored, so we stamp stored responses with the storage time and
 * evaluate freshness against the response's own `max-age` on read.
 */

export const CACHED_AT_HEADER = 'x-sentinel-cached-at';

/**
 * Whether a response may be stored at all: OK responses without
 * `no-store`. `private` is fine — this cache belongs to a single user.
 */
export function isCacheable(response: Response): boolean {
  if (!response.ok) return false;
  const cacheControl = response.headers.get('cache-control') ?? '';
  return !/(?:^|,)\s*no-store\b/i.test(cacheControl);
}

/**
 * Copy of the response carrying the storage-time stamp. Consumes the
 * given response body — pass a clone if the original is still needed.
 */
export function withCacheStamp(response: Response, now: number = Date.now()): Response {
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT_HEADER, String(now));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Whether a stored response is still within its `max-age` (falling back
 * to `defaultMaxAgeSeconds` when the origin sent none). Unstamped
 * entries — including anything stored before this policy existed — are
 * always stale.
 */
export function isFresh(
  cached: Response,
  defaultMaxAgeSeconds: number,
  now: number = Date.now(),
): boolean {
  const storedAt = Number(cached.headers.get(CACHED_AT_HEADER));
  if (!Number.isFinite(storedAt) || storedAt <= 0) return false;
  const maxAge = maxAgeSeconds(cached) ?? defaultMaxAgeSeconds;
  return now - storedAt < maxAge * 1000;
}

function maxAgeSeconds(response: Response): number | null {
  const cacheControl = response.headers.get('cache-control') ?? '';
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl);
  return match ? Number(match[1]) : null;
}
