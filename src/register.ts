// Service Worker Registration API

import type {
  AssetSecurityConfig,
  RegistrationResult,
  SecurityEvent,
} from './public-types.js';

// Global state
let swRegistration: ServiceWorkerRegistration | null = null;
let config: AssetSecurityConfig | null = null;
let eventListeners: Set<(event: SecurityEvent) => void> = new Set();
const DEFAULT_SERVICE_WORKER_CONTROL_TIMEOUT = 5000;

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
    config = {
      ...userConfig,
      namespace: userConfig.namespace ?? 'asset-security',
      scope: userConfig.scope ?? '/',
      serviceWorkerPath: userConfig.serviceWorkerPath ?? '/sw.js',
      serviceWorkerControlTimeout:
        userConfig.serviceWorkerControlTimeout ?? DEFAULT_SERVICE_WORKER_CONTROL_TIMEOUT,
      debug: userConfig.debug ?? false,
    };

    // Register event listeners
    if (config.onSecurityEvent) {
      eventListeners.add(config.onSecurityEvent);
    }

    // Log configuration in debug mode
    if (config.debug) {
      console.log('[AssetSecurity] Registering with config:', config);
    }

    // Check if already registered
    const existingRegistration = await navigator.serviceWorker.getRegistration(
      config.scope
    );

    if (existingRegistration) {
      swRegistration = existingRegistration;

      if (config.debug) {
        console.log('[AssetSecurity] Service worker already registered');
      }

      // Send configuration to existing service worker
      await waitForServiceWorkerActive(existingRegistration);
      await sendConfigToServiceWorker();
      await waitForServiceWorkerControl(
        existingRegistration,
        config.serviceWorkerControlTimeout
      );

      emitEvent({
        type: 'registration:success',
        timestamp: Date.now(),
        data: { existing: true },
      });

      return { success: true, registration: existingRegistration };
    }

    // Register new service worker (serviceWorkerPath is guaranteed by defaults above)
    swRegistration = await navigator.serviceWorker.register(
      config.serviceWorkerPath!,
      {
        scope: config.scope!,
      }
    );

    if (config.debug) {
      console.log('[AssetSecurity] Service worker registered successfully');
    }

    // Wait for service worker to become active
    await waitForServiceWorkerActive(swRegistration);

    // Send configuration to service worker
    await sendConfigToServiceWorker();
    await waitForServiceWorkerControl(
      swRegistration,
      config.serviceWorkerControlTimeout
    );

    // Set up message listener from service worker
    setupMessageListener();

    emitEvent({
      type: 'registration:success',
      timestamp: Date.now(),
      data: { existing: false },
    });

    return { success: true, registration: swRegistration };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    if (config?.debug) {
      console.error('[AssetSecurity] Registration failed:', err);
    }

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

  const debugMode = config?.debug;

  try {
    const success = await swRegistration.unregister();

    if (success) {
      swRegistration = null;
      config = null;
      eventListeners.clear();

      if (debugMode) {
        console.log('[AssetSecurity] Service worker unregistered');
      }
    }

    return success;
  } catch (error) {
    if (debugMode) {
      console.error('[AssetSecurity] Unregistration failed:', error);
    }
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

async function waitForServiceWorkerActive(
  registration: ServiceWorkerRegistration
): Promise<void> {
  return new Promise((resolve) => {
    if (registration.active) {
      resolve();
      return;
    }

    const worker = registration.installing || registration.waiting;
    if (!worker) {
      resolve();
      return;
    }

    worker.addEventListener('statechange', function onStateChange() {
      if (worker.state === 'activated') {
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
    if (config?.debug) {
      console.log('[AssetSecurity] Service worker already controlling the page');
    }
    return;
  }

  const activeWorker = registration.active;
  if (!activeWorker) {
    if (config?.debug) {
      console.warn('[AssetSecurity] Service worker is not active, cannot claim clients');
    }
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

      if (config?.debug) {
        if (controlled) {
          console.log('[AssetSecurity] Service worker is controlling the page');
        } else if (timedOut) {
          console.warn(
            '[AssetSecurity] Service worker did not gain control before timeout; protected requests may bypass authentication'
          );
        }
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

    if (config?.debug) {
      console.log('[AssetSecurity] Requested service worker client control');
    }
  });
}

async function sendConfigToServiceWorker(): Promise<void> {
  if (!swRegistration?.active || !config) {
    return;
  }

  // Send configuration to service worker
  swRegistration.active.postMessage({
    type: 'CONFIG',
    payload: {
      namespace: config.namespace,
      protectedDomains: config.protectedDomains,
      assetPatterns: config.assetPatterns,
      extractAssetId: config.extractAssetId,
      tokenConfig: config.tokenConfig,
      cacheStrategies: config.cacheStrategies,
      api: {
        proxyEndpoint: config.proxyUrl,
      },
      debug: config.debug,
    },
  });
}

function setupMessageListener(): void {
  if (!config) return;

  navigator.serviceWorker.addEventListener('message', (event) => {
    const { type, payload } = event.data;

    if (config?.debug) {
      console.log('[AssetSecurity] Message from SW:', type, payload);
    }

    switch (type) {
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
      if (config?.debug) {
        console.error('[AssetSecurity] Event listener error:', error);
      }
    }
  });
}
