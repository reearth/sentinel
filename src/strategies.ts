/**
 * Fetch strategies for intercepted requests. Extracted from sw.ts so
 * they can be unit-tested without a ServiceWorker global scope.
 *
 * All cache writes go through `cachePut`, which refuses `no-store`
 * responses and stamps the storage time; cache-first reads honor the
 * response's own `max-age` (see cache-policy.ts). A fresh hit is served
 * without touching the network — no background refresh, which would
 * defeat the point of caching tiles and double upstream traffic.
 */

import { requestInterceptor } from './request-interceptor';
import {
  CONFIG,
  debugError,
  debugLog,
  getAssetType,
  getCacheKey,
  getCacheName,
  getCacheStrategy,
} from './config';
import { isCacheable, isFresh, withCacheStamp } from './cache-policy';

/**
 * Dispatch a request to the configured strategy for its asset type.
 */
export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const assetType = getAssetType(url);
  const strategy = getCacheStrategy(assetType);

  debugLog(`[ServiceWorker] Handling ${assetType} with ${strategy} strategy:`, url.pathname);

  switch (strategy) {
    case 'cache-first':
      return cacheFirst(request);
    case 'network-first':
      return networkFirst(request);
    case 'cache-only':
      return cacheOnly(request);
    case 'network-only':
    default:
      return networkOnly(request);
  }
}

/**
 * Cache-first: serve a fresh cached copy outright; refetch once it has
 * outlived its max-age, falling back to the stale copy on failure.
 */
export async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(getCacheName());
  const cacheKey = getCacheKey(request);

  const cached = await cache.match(cacheKey);
  if (cached && isFresh(cached, CONFIG.cache.maxAge)) {
    debugLog('[ServiceWorker] Cache hit (fresh):', request.url);
    return cached;
  }

  try {
    const response = await requestInterceptor.processRequest(request);
    if (response.ok) {
      await cachePut(cache, cacheKey, response);
    }
    return response;
  } catch (error) {
    if (cached) {
      debugLog('[ServiceWorker] Network failed, serving stale cache:', request.url);
      return cached;
    }
    debugError('[ServiceWorker] Network error:', error);
    return new Response('Network error', {
      status: 503,
      statusText: 'Service Unavailable',
    });
  }
}

/**
 * Network-first: always try the network; the cache (fresh or stale) is
 * only a fallback when the network fails.
 */
export async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(getCacheName());
  const cacheKey = getCacheKey(request);

  try {
    const response = await requestInterceptor.processRequest(request);
    if (response.ok) {
      await cachePut(cache, cacheKey, response);
    }
    return response;
  } catch (error) {
    debugError('[ServiceWorker] Network error, trying cache:', error);

    const cached = await cache.match(cacheKey);
    if (cached) {
      debugLog('[ServiceWorker] Returning cached response');
      return cached;
    }

    return new Response('Network error', {
      status: 503,
      statusText: 'Service Unavailable',
    });
  }
}

/**
 * Cache-only strategy
 */
export async function cacheOnly(request: Request): Promise<Response> {
  const cache = await caches.open(getCacheName());
  const cacheKey = getCacheKey(request);
  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached;
  }

  return new Response('Not in cache', {
    status: 404,
    statusText: 'Not Found',
  });
}

/**
 * Network-only strategy (for documents)
 */
export async function networkOnly(request: Request): Promise<Response> {
  try {
    return await requestInterceptor.processRequest(request);
  } catch (error) {
    debugError('[ServiceWorker] Network error:', error);
    return new Response('Network error', {
      status: 503,
      statusText: 'Service Unavailable',
    });
  }
}

/**
 * Store a response copy if its Cache-Control permits, stamped with the
 * storage time so reads can evaluate freshness.
 */
async function cachePut(cache: Cache, cacheKey: Request, response: Response): Promise<void> {
  if (!isCacheable(response)) return;
  await cache.put(cacheKey, withCacheStamp(response.clone()));
}
