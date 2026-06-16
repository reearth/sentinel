// Client API for interacting with the Asset Security Service Worker

import type {
  TokenUpdateOptions,
  AssetSecurityStatus,
} from './public-types.js';
import {
  getRegistration,
  getConfig,
  debugLog,
  debugWarn,
  debugError,
} from './register.js';

/**
 * Update the authentication token in the service worker
 *
 * Call this when the user logs in or when a token is refreshed
 *
 * @example
 * ```typescript
 * import { updateToken } from '@reearth/sentinel';
 *
 * // After user login
 * const token = await yourAuthSystem.getToken();
 * await updateToken({
 *   accessToken: token,
 *   expiresAt: Date.now() + 3600000 // 1 hour
 * });
 * ```
 */
export async function updateToken(
  options: TokenUpdateOptions
): Promise<boolean> {
  const registration = getRegistration();

  if (!registration?.active) {
    debugWarn('[AssetSecurity] Service worker not active, cannot update token');
    return false;
  }

  try {
    const expiresAt = options.expiresAt || Date.now() + 3600000; // Default 1 hour

    // Send token to service worker
    const messageChannel = new MessageChannel();

    registration.active.postMessage(
      {
        type: 'UPDATE_TOKEN',
        payload: {
          token: {
            access_token: options.accessToken,
            expires_at: expiresAt,
            refresh_token: options.refreshToken,
            scope: options.scope,
          },
        },
      },
      [messageChannel.port2]
    );

    // Wait for acknowledgment
    return new Promise((resolve) => {
      messageChannel.port1.onmessage = (event) => {
        debugLog('[AssetSecurity] Token updated successfully');
        resolve(event.data.success || false);
      };

      // Timeout after 5 seconds
      setTimeout(() => {
        debugWarn('[AssetSecurity] Token update timeout');
        resolve(false);
      }, 5000);
    });
  } catch (error) {
    debugError('[AssetSecurity] Failed to update token:', error);
    return false;
  }
}

/**
 * Clear the authentication token from the service worker
 *
 * Call this when the user logs out
 *
 * @example
 * ```typescript
 * import { clearToken } from '@reearth/sentinel';
 *
 * // On logout
 * await clearToken();
 * ```
 */
export async function clearToken(): Promise<boolean> {
  const registration = getRegistration();

  if (!registration?.active) {
    debugWarn('[AssetSecurity] Service worker not active, cannot clear token');
    return false;
  }

  try {
    registration.active.postMessage({
      type: 'CLEAR_CACHE',
    });

    debugLog('[AssetSecurity] Token cleared');

    return true;
  } catch (error) {
    debugError('[AssetSecurity] Failed to clear token:', error);
    return false;
  }
}

/**
 * Get the current status of the asset security system
 *
 * @example
 * ```typescript
 * import { getSecurityStatus } from '@reearth/sentinel';
 *
 * const status = await getSecurityStatus();
 * console.log('Is authenticated:', status.isAuthenticated);
 * console.log('Cached requests:', status.cachedRequests);
 * ```
 */
export async function getSecurityStatus(): Promise<AssetSecurityStatus> {
  const registration = getRegistration();
  const config = getConfig();

  // Basic status if no registration
  if (!registration) {
    return {
      isRegistered: false,
      isAuthenticated: false,
      proxyStatus: 'unknown',
    };
  }

  // Check if service worker is active
  const isRegistered = !!registration.active;

  // Get detailed status from service worker
  if (registration.active) {
    try {
      const messageChannel = new MessageChannel();

      registration.active.postMessage(
        { type: 'GET_STATUS' },
        [messageChannel.port2]
      );

      // Wait for response
      const swStatus = await new Promise<any>((resolve) => {
        messageChannel.port1.onmessage = (event) => {
          resolve(event.data);
        };

        // Timeout after 3 seconds
        setTimeout(() => {
          resolve({});
        }, 3000);
      });

      // Check proxy status
      let proxyStatus: 'connected' | 'disconnected' | 'unknown' = 'unknown';
      if (config?.proxyUrl) {
        try {
          const response = await fetch(`${config.proxyUrl}/health`, {
            method: 'GET',
            cache: 'no-cache',
          });
          proxyStatus = response.ok ? 'connected' : 'disconnected';
        } catch {
          proxyStatus = 'disconnected';
        }
      }

      return {
        isRegistered,
        isAuthenticated: swStatus.hasToken || false,
        version: swStatus.version,
        cachedRequests: swStatus.cachedRequests,
        caches: swStatus.caches,
        tokenExpiresAt: swStatus.tokenExpiresAt,
        proxyStatus,
      };
    } catch (error) {
      debugError('[AssetSecurity] Failed to get status:', error);
    }
  }

  // Fallback status
  return {
    isRegistered,
    isAuthenticated: false,
    proxyStatus: 'unknown',
  };
}

/**
 * Clear all cached assets
 *
 * Useful for debugging or when assets need to be force-refreshed
 *
 * @example
 * ```typescript
 * import { clearCache } from '@reearth/sentinel';
 *
 * await clearCache();
 * ```
 */
export async function clearCache(): Promise<boolean> {
  const registration = getRegistration();

  if (!registration?.active) {
    debugWarn('[AssetSecurity] Service worker not active, cannot clear cache');
    return false;
  }

  try {
    registration.active.postMessage({
      type: 'CLEAR_CACHE',
    });

    debugLog('[AssetSecurity] Cache cleared');

    return true;
  } catch (error) {
    debugError('[AssetSecurity] Failed to clear cache:', error);
    return false;
  }
}

/**
 * Force update the service worker
 *
 * Checks for updates and activates new version if available
 *
 * @example
 * ```typescript
 * import { forceUpdate } from '@reearth/sentinel';
 *
 * await forceUpdate();
 * ```
 */
export async function forceUpdate(): Promise<boolean> {
  const registration = getRegistration();

  if (!registration) {
    debugWarn('[AssetSecurity] No registration found');
    return false;
  }

  try {
    await registration.update();

    debugLog('[AssetSecurity] Service worker update check complete');

    return true;
  } catch (error) {
    debugError('[AssetSecurity] Failed to update service worker:', error);
    return false;
  }
}
