/// <reference lib="webworker" />
import { tokenManager } from './token-manager';
import { requestInterceptor } from './request-interceptor';
import { handleRequest } from './strategies';
import {
  configure,
  debugLog,
  debugWarn,
  getCacheName,
  isStaleCacheName,
} from './config';
import { CONFIG_PARAM, decodeRuntimeConfig, parseLegacyConfigMessage } from './runtime-config';
import type { ServiceWorkerMessage, Token } from './types';

declare const self: ServiceWorkerGlobalScope;

const urlConfig = decodeRuntimeConfig(self.location.search);
if (!urlConfig && new URLSearchParams(self.location.search).has(CONFIG_PARAM)) {
  console.warn(
    `[ServiceWorker] The "${CONFIG_PARAM}" config in the script URL is unreadable; protected requests will not be authenticated`
  );
}
configure(urlConfig);

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
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.filter(isStaleCacheName).map((name) => caches.delete(name)));

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
 * Handle messages from the main thread
 */
self.addEventListener('message', (event) => {
  // Without waitUntil the browser may terminate the worker mid IndexedDB write.
  event.waitUntil(handleMessage(event));
});

async function handleMessage(event: ExtendableMessageEvent): Promise<void> {
  const message = event.data as ServiceWorkerMessage;

  debugLog('[ServiceWorker] Received message:', message.type);

  switch (message.type) {
    case 'CONFIG': {
      if (urlConfig) {
        debugWarn('[ServiceWorker] Ignoring CONFIG message: config travels in the script URL');
        break;
      }
      const legacy = parseLegacyConfigMessage(message.payload);
      if (legacy) configure(legacy);
      else debugWarn('[ServiceWorker] Ignoring unreadable CONFIG message');
      event.ports[0]?.postMessage({ success: !!legacy });
      break;
    }

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
}

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
