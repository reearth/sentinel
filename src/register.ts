// Service Worker Registration API

import type {
  AssetSecurityConfig,
  RegistrationResult,
  SecurityEvent,
} from './public-types.js';
import { decodeRuntimeConfig, serviceWorkerScriptUrl, toRuntimeConfig } from './runtime-config.js';
import {
  createTokenResponder,
  forgetToken,
  latestToken,
  type TokenReply,
  type TokenRequest,
} from './token-provider.js';

// Global state
let swRegistration: ServiceWorkerRegistration | null = null;
let config: AssetSecurityConfig | null = null;
let eventListeners: Set<(event: SecurityEvent) => void> = new Set();
let answerTokenRequest: ((request: TokenRequest) => Promise<TokenReply>) | null = null;
const DEFAULT_SERVICE_WORKER_CONTROL_TIMEOUT = 5000;
const DEFAULT_REFRESH_THRESHOLD = 60_000;

// Debug logging for the page side. The service worker has its own helpers in
// config.ts; this code runs in the page and reads the page-side config, so it
// can't share those. Both go quiet unless the consumer opts in with debug: true.
export function debugLog(...args: unknown[]): void {
  if (config?.debug) {
    console.log(...args);
  }
}

export function debugWarn(...args: unknown[]): void {
  if (config?.debug) {
    console.warn(...args);
  }
}

export function debugError(...args: unknown[]): void {
  if (config?.debug) {
    console.error(...args);
  }
}

/**
 * Register the asset security service worker
 *
 * @example
 * ```typescript
 * import { registerAssetSecurity } from '@reearth/sentinel';
 *
 * await registerAssetSecurity({
 *   proxyUrl: 'https://proxy.example.com',
 *   protectedDomains: ['storage.googleapis.com', 'cdn.example.com'],
 *   onTokenExpired: async () => {
 *     const newToken = await yourAuthSystem.getToken();
 *     await updateToken({ accessToken: newToken });
 *   }
 *   });
 * ```
 */
export async function registerAssetSecurity(
  userConfig: AssetSecurityConfig
): Promise<RegistrationResult> {
  // Check for service worker support
  if (!('serviceWorker' in navigator)) {
    const error = new Error('Service Workers are not supported in this browser');
    emitEvent({
      type: 'registration:error',
      timestamp: Date.now(),
      error,
    });
    return { success: false, error };
  }

  try {
    // Validate required config
    if (!userConfig.proxyUrl) {
      throw new Error('proxyUrl is required');
    }
    if (!userConfig.protectedDomains || userConfig.protectedDomains.length === 0) {
      throw new Error('protectedDomains is required and must not be empty');
    }

    // Merge with defaults - ensure all optional fields have values
    const resolved = {
      ...userConfig,
      namespace: userConfig.namespace ?? 'asset-security',
      scope: userConfig.scope ?? '/',
      serviceWorkerPath: userConfig.serviceWorkerPath ?? '/sw.js',
      serviceWorkerControlTimeout:
        userConfig.serviceWorkerControlTimeout ?? DEFAULT_SERVICE_WORKER_CONTROL_TIMEOUT,
      debug: userConfig.debug ?? false,
    };
    config = resolved;

    // Register event listeners
    if (config.onSecurityEvent) {
      eventListeners.add(config.onSecurityEvent);
    }

    if (config.extractAssetId) {
      debugWarn('[AssetSecurity] extractAssetId is deprecated and ignored: functions cannot reach the service worker');
    }

    debugLog('[AssetSecurity] Registering with config:', config);

    answerTokenRequest = createTokenResponder({
      latest: latestToken,
      onTokenExpired: resolved.onTokenExpired,
      refreshThreshold: resolved.tokenConfig?.refreshThreshold ?? DEFAULT_REFRESH_THRESHOLD,
      now: () => Date.now(),
    });
    ensureMessageListener();

    const scriptUrl = serviceWorkerScriptUrl(resolved.serviceWorkerPath, toRuntimeConfig(resolved));
    // The worker would start unconfigured and intercept nothing.
    if (!decodeRuntimeConfig(scriptUrl.slice(scriptUrl.indexOf('?')))) {
      throw new Error('The service worker could not read back this configuration');
    }

    const existing = !!navigator.serviceWorker.controller;
    // Same config, same URL: the browser keeps the running worker. A changed
    // config, or a legacy bare serviceWorkerPath, installs a new one.
    swRegistration = await navigator.serviceWorker.register(scriptUrl, { scope: resolved.scope });

    await waitForNewestWorkerActive(swRegistration);
    await waitForServiceWorkerControl(swRegistration, resolved.serviceWorkerControlTimeout);

    emitEvent({
      type: 'registration:success',
      timestamp: Date.now(),
      data: { existing },
    });

    return { success: true, registration: swRegistration };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    debugError('[AssetSecurity] Registration failed:', err);

    if (config?.onRegistrationError) {
      config.onRegistrationError(err);
    }

    emitEvent({
      type: 'registration:error',
      timestamp: Date.now(),
      error: err,
    });

    return { success: false, error: err };
  }
}

/**
 * Unregister the asset security service worker
 */
export async function unregisterAssetSecurity(): Promise<boolean> {
  if (!swRegistration) {
    return false;
  }

  try {
    const success = await swRegistration.unregister();

    if (success) {
      // Log before clearing config, otherwise the helper can't see debug.
      debugLog('[AssetSecurity] Service worker unregistered');
      swRegistration = null;
      config = null;
      answerTokenRequest = null;
      forgetToken();
      eventListeners.clear();
    }

    return success;
  } catch (error) {
    debugError('[AssetSecurity] Unregistration failed:', error);
    return false;
  }
}

/**
 * Get the current service worker registration
 */
export function getRegistration(): ServiceWorkerRegistration | null {
  return swRegistration;
}

/**
 * Get the current configuration
 */
export function getConfig(): AssetSecurityConfig | null {
  return config;
}

// Internal helpers

/**
 * Waits for the newest worker, not just any active one: when the script URL
 * changed, register() resolves while the new worker is still installing and
 * the old, differently configured one is still active.
 */
async function waitForNewestWorkerActive(
  registration: ServiceWorkerRegistration
): Promise<void> {
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker || worker.state === 'activated') return;

  await new Promise<void>((resolve) => {
    worker.addEventListener('statechange', function onStateChange() {
      if (worker.state === 'activated' || worker.state === 'redundant') {
        worker.removeEventListener('statechange', onStateChange);
        resolve();
      }
    });
  });
}

async function waitForServiceWorkerControl(
  registration: ServiceWorkerRegistration,
  timeoutMs = DEFAULT_SERVICE_WORKER_CONTROL_TIMEOUT
): Promise<void> {
  if (navigator.serviceWorker.controller) {
    debugLog('[AssetSecurity] Service worker already controlling the page');
    return;
  }

  const activeWorker = registration.active;
  if (!activeWorker) {
    debugWarn('[AssetSecurity] Service worker is not active, cannot claim clients');
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (controlled: boolean, timedOut = false) => {
      if (settled) return;
      settled = true;

      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      if (timeout) {
        clearTimeout(timeout);
      }

      if (controlled) {
        debugLog('[AssetSecurity] Service worker is controlling the page');
      } else if (timedOut) {
        debugWarn(
          '[AssetSecurity] Service worker did not gain control before timeout; protected requests may bypass authentication'
        );
      }

      resolve();
    };

    const onControllerChange = () => {
      finish(true);
    };

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange, {
      once: true,
    });

    timeout = setTimeout(() => {
      finish(!!navigator.serviceWorker.controller, true);
    }, timeoutMs);

    if (navigator.serviceWorker.controller) {
      finish(true);
      return;
    }

    activeWorker.postMessage({ type: 'CLAIM_CLIENTS' });

    debugLog('[AssetSecurity] Requested service worker client control');
  });
}

let listening = false;

function ensureMessageListener(): void {
  if (listening) return;
  listening = true;

  navigator.serviceWorker.addEventListener('message', (event) => {
    const { type, payload } = event.data;

    debugLog('[AssetSecurity] Message from SW:', type, payload);

    switch (type) {
      case 'REQUEST_TOKEN':
      case 'REFRESH_TOKEN': {
        const port = event.ports[0];
        if (!port) break;
        const unavailable: TokenReply = { type: 'TOKEN_UNAVAILABLE' };
        (answerTokenRequest?.(event.data) ?? Promise.resolve(unavailable)).then((reply) =>
          port.postMessage(reply)
        );
        break;
      }

      case 'TOKEN_EXPIRED':
        if (config?.onTokenExpired) {
          config.onTokenExpired();
        }
        emitEvent({
          type: 'token:expired',
          timestamp: Date.now(),
        });
        break;

      case 'TOKEN_REFRESHED':
        if (config?.onTokenRefreshed) {
          config.onTokenRefreshed(payload.token);
        }
        emitEvent({
          type: 'token:refreshed',
          timestamp: Date.now(),
          data: payload,
        });
        break;

      case 'REQUEST_INTERCEPTED':
        emitEvent({
          type: 'request:intercepted',
          timestamp: Date.now(),
          data: payload,
        });
        break;

      case 'REQUEST_AUTHENTICATED':
        emitEvent({
          type: 'request:authenticated',
          timestamp: Date.now(),
          data: payload,
        });
        break;

      case 'REQUEST_FAILED':
        emitEvent({
          type: 'request:failed',
          timestamp: Date.now(),
          data: payload,
        });
        break;
    }
  });
}

function emitEvent(event: SecurityEvent): void {
  eventListeners.forEach((listener) => {
    try {
      listener(event);
    } catch (error) {
      debugError('[AssetSecurity] Event listener error:', error);
    }
  });
}
