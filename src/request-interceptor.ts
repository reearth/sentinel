import type { RequestInterceptor as IRequestInterceptor } from './types';
import { isProtectedDomain, getAssetType, extractAssetUUID, getCacheName } from './config';
import { tokenManager } from './token-manager';

export class RequestInterceptor implements IRequestInterceptor {
  /**
   * Determine if a request should be intercepted
   */
  shouldIntercept(request: Request): boolean {
    const url = new URL(request.url);

    // Only intercept protected domains
    if (!isProtectedDomain(url)) {
      return false;
    }

    // Only intercept GET requests for now
    if (request.method !== 'GET') {
      return false;
    }

    // Check if it's an asset request
    const assetType = getAssetType(url);
    return assetType !== 'unknown';
  }

  /**
   * Add authentication header to request
   */
  addAuthentication(request: Request, token: string): Request {
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${token}`);

    console.log('[RequestInterceptor] Adding Authorization header:', `Bearer ${token.substring(0, 20)}...`);

    return new Request(request.url, {
      method: request.method,
      headers: headers,
      body: request.body,
      mode: 'cors', // Force CORS mode to allow custom headers
      credentials: 'include', // Important for CORS
      cache: request.cache,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      integrity: request.integrity,
    });
  }

  /**
   * Handle authentication errors (401/403)
   */
  async handleAuthError(request: Request): Promise<Response> {
    console.log('[RequestInterceptor] Handling auth error, attempting token refresh...');

    // Try to refresh token
    const newToken = await tokenManager.refreshToken();

    if (!newToken) {
      console.log('[RequestInterceptor] Token refresh failed');
      return new Response('Authentication failed', {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
          'Content-Type': 'text/plain',
        },
      });
    }

    // Retry request with new token
    console.log('[RequestInterceptor] Retrying request with refreshed token');
    const authenticatedRequest = this.addAuthentication(request, newToken);

    try {
      const response = await fetch(authenticatedRequest);

      // If still getting auth error, clear token and return error
      if (response.status === 401 || response.status === 403) {
        await tokenManager.clearToken();
        return new Response('Authentication failed after refresh', {
          status: 401,
          statusText: 'Unauthorized',
        });
      }

      return response;
    } catch (error) {
      console.error('[RequestInterceptor] Error retrying request:', error);
      return new Response('Network error', {
        status: 503,
        statusText: 'Service Unavailable',
      });
    }
  }

  /**
   * Process intercepted request
   */
  async processRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const assetType = getAssetType(url);
    const assetId = extractAssetUUID(url);

    console.log(`[RequestInterceptor] Processing ${assetType} request:`, {
      url: url.pathname,
      assetId,
      assetType,
    });

    // Get authentication token
    const token = await tokenManager.getToken();

    if (!token) {
      console.log('[RequestInterceptor] No token available');
      // For public assets, try without authentication
      return fetch(request);
    }

    // Add authentication to request
    const authenticatedRequest = this.addAuthentication(request, token);

    try {
      const response = await fetch(authenticatedRequest);

      // Handle authentication errors
      if (response.status === 401 || response.status === 403) {
        return await this.handleAuthError(request);
      }

      // Clone response for caching if successful
      if (response.ok) {
        return response;
      }

      return response;
    } catch (error) {
      console.error('[RequestInterceptor] Network error:', error);

      // Try to return cached version if available
      const cache = await caches.open(getCacheName());
      const cachedResponse = await cache.match(request);

      if (cachedResponse) {
        console.log('[RequestInterceptor] Returning cached response');
        return cachedResponse;
      }

      throw error;
    }
  }

  /**
   * Handle tile requests with special prefix-based authentication
   */
  async processTileRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const assetId = extractAssetUUID(url);

    if (!assetId) {
      return fetch(request);
    }

    console.log('[RequestInterceptor] Processing tile request:', {
      url: url.pathname,
      assetId,
    });

    // Get token for authentication
    const token = await tokenManager.getToken();

    if (!token) {
      console.log('[RequestInterceptor] No token for tile request');
      return fetch(request);
    }

    // For tile requests, we might want to use a different strategy
    // such as getting a signed URL from the proxy first
    const signedUrlResponse = await this.getSignedUrl(assetId, token);

    if (signedUrlResponse?.url) {
      // Use signed URL for the actual request
      const signedRequest = new Request(signedUrlResponse.url, {
        method: request.method,
        headers: request.headers,
        mode: 'cors',
        credentials: 'omit', // Don't send credentials with signed URL
      });

      return fetch(signedRequest);
    }

    // Fallback to regular authenticated request
    return this.processRequest(request);
  }

  /**
   * Get signed URL from proxy service
   * Note: This requires CONFIG.api.proxyEndpoint to be set
   */
  private async getSignedUrl(
    assetId: string,
    token: string
  ): Promise<{ url: string; expires_at: number } | null> {
    try {
      const { CONFIG } = await import('./config.js');
      const proxyUrl = CONFIG.api.proxyEndpoint;

      if (!proxyUrl) {
        console.error('[RequestInterceptor] Proxy endpoint not configured');
        return null;
      }

      const response = await fetch(`${proxyUrl}/api/signed-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          assetId,
          prefix: true, // Enable prefix support for tiles
          expiry: 900, // 15 minutes
        }),
      });

      if (!response.ok) {
        console.error('[RequestInterceptor] Failed to get signed URL');
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('[RequestInterceptor] Error getting signed URL:', error);
      return null;
    }
  }
}

// Export singleton instance
export const requestInterceptor = new RequestInterceptor();
