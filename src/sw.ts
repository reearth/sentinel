/// <reference lib="webworker" />
import { tokenManager } from './token-manager';
import { requestInterceptor } from './request-interceptor';
import {
  debugDebug,
  debugError,
  debugLog,
  debugWarn,
  getAssetType,
  getCacheStrategy,
  getCacheKey,
  getCacheName,
  updateConfig,
} from './config';
import type { ServiceWorkerMessage, Token } from './types';

declare const self: ServiceWorkerGlobalScope;

/**
 * Service Worker installation
 */
self.addEventListener('install', (_event) => {
  debugLog('[ServiceWorker] Installing...');
  // Skip waiting to activate immediately
  self.skipWaiting();
});

/**
 * Service Worker activation
 */
self.addEventListener('activate', (event) => {
  debugLog('[ServiceWorker] Activating...');

  event.waitUntil(
    (async () => {
      const currentCacheName = getCacheName();
      // Clean up old caches (keep only current version)
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name !== currentCacheName)
          .map((name) => caches.delete(name))
      );

      // Claim all clients
      await self.clients.claim();
      debugLog('[ServiceWorker] Active and controlling all clients');
    })()
  );
});

/**
 * Fetch event handler - Main request interception
 */
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Skip non-GET requests
  if (request.method !== 'GET') {
    event.respondWith(fetch(request));
    return;
  }

  // Check if request should be intercepted
  if (!requestInterceptor.shouldIntercept(request)) {
    event.respondWith(fetch(request));
    return;
  }

  // Handle intercepted request
  event.respondWith(handleRequest(request));
});

/**
 * Handle intercepted requests with caching strategies
 */
async function handleRequest(request: Request): Promise<Response> {
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
 * Cache-first strategy (for images)
 */
async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(getCacheName());
  const cacheKey = getCacheKey(request);

  // Try cache first
  const cached = await cache.match(cacheKey);
  if (cached) {
    debugLog('[ServiceWorker] Cache hit:', request.url);
    // Refresh cache in background
    refreshCache(request, cache);
    return cached;
  }

  // Network fallback
  debugLog('[ServiceWorker] Cache miss, fetching:', request.url);
  try {
    const response = await requestInterceptor.processRequest(request);

    // Cache successful responses
    if (response.ok) {
      const cloned = response.clone();
      cache.put(cacheKey, cloned);
    }

    return response;
  } catch (error) {
    debugError('[ServiceWorker] Network error:', error);
    return new Response('Network error', {
      status: 503,
      statusText: 'Service Unavailable',
    });
  }
}

/**
 * Network-first strategy (for tiles)
 */
async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(getCacheName());
  const cacheKey = getCacheKey(request);

  try {
    const response = await requestInterceptor.processRequest(request);

    // Cache successful responses
    if (response.ok) {
      const cloned = response.clone();
      cache.put(cacheKey, cloned);
    }

    return response;
  } catch (error) {
    debugError('[ServiceWorker] Network error, trying cache:', error);

    // Try cache on network failure
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
async function cacheOnly(request: Request): Promise<Response> {
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
async function networkOnly(request: Request): Promise<Response> {
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
 * Refresh cache in background
 */
async function refreshCache(request: Request, cache: Cache): Promise<void> {
  try {
    const response = await requestInterceptor.processRequest(request);
    if (response.ok) {
      const cacheKey = getCacheKey(request);
      await cache.put(cacheKey, response);
      debugLog('[ServiceWorker] Cache refreshed:', request.url);
    }
  } catch (error) {
    // Ignore errors in background refresh
    debugDebug('[ServiceWorker] Background refresh failed:', error);
  }
}

/**
 * Handle messages from the main thread
 */
self.addEventListener('message', async (event) => {
  const message = event.data as ServiceWorkerMessage;

  debugLog('[ServiceWorker] Received message:', message.type);

  switch (message.type) {
    case 'CONFIG':
      // Update service worker configuration
      if (message.payload) {
        updateConfig(message.payload);
        event.ports[0]?.postMessage({ success: true });
      }
      break;

    case 'UPDATE_TOKEN':
      if (message.payload?.token) {
        await tokenManager.setToken(message.payload.token as Token);
        event.ports[0]?.postMessage({ success: true });
      }
      break;

    case 'REQUEST_TOKEN':
      // This is handled by token manager
      break;

    case 'CLEAR_CACHE':
      await clearAllCaches();
      event.ports[0]?.postMessage({ success: true });
      break;

    case 'GET_STATUS':
      const status = await getServiceWorkerStatus();
      event.ports[0]?.postMessage(status);
      break;

    case 'CLAIM_CLIENTS':
      await self.clients.claim();
      event.ports[0]?.postMessage({ success: true });
      console.log('[ServiceWorker] Claimed clients via explicit message');
      break;

    default:
      debugWarn('[ServiceWorker] Unknown message type:', message.type);
  }
});

/**
 * Clear all caches
 */
async function clearAllCaches(): Promise<void> {
  const cacheNames = await caches.keys();
  await Promise.all(cacheNames.map((name) => caches.delete(name)));
  await tokenManager.clearToken();
  debugLog('[ServiceWorker] All caches cleared');
}

/**
 * Get service worker status
 */
async function getServiceWorkerStatus(): Promise<object> {
  const cacheNames = await caches.keys();
  const cache = await caches.open(getCacheName());
  const requests = await cache.keys();

  return {
    version: '1.0.0',
    caches: cacheNames,
    cachedRequests: requests.length,
    hasToken: !!(await tokenManager.getToken()),
  };
}

// Log service worker registration
debugLog('[ServiceWorker] Script loaded, waiting for events...');
