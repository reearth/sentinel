// Public API Types for Asset Security Service Worker Library

import type { Token } from './types.js';

/**
 * Configuration for Asset Security Library
 */
export interface AssetSecurityConfig {
  /**
   * URL of the authentication proxy server (REQUIRED)
   * @example 'https://proxy.example.com' or 'http://localhost:8090' for development
   */
  proxyUrl: string;

  /**
   * Domains that require authentication (REQUIRED)
   * List of domain names (with optional ports) that should have auth headers added
   * @example ['storage.googleapis.com', 'assets.example.com', 'localhost:8080']
   */
  protectedDomains: string[];

  /**
   * Custom asset patterns for your use case (RECOMMENDED)
   * Define regex patterns to identify different types of assets
   * @example {
   *   images: /\.(jpg|png|gif)$/i,
   *   tiles: /\/tiles\/\d+\/\d+\/\d+/,
   *   documents: /\.(pdf|doc)$/i
   * }
   */
  assetPatterns?: {
    customAssets?: RegExp;
    mvtTiles?: RegExp;
    rasterTiles?: RegExp;
    generalAssets?: RegExp;
  };

  /**
   * Custom function to extract asset ID from URL (OPTIONAL)
   * Useful if your URLs have a specific structure
   * @example (url) => url.pathname.match(/\/assets\/([^/]+)/)?.[1] ?? null
   */
  extractAssetId?: (url: URL) => string | null;

  /**
   * Namespace for cache and storage isolation
   * Different applications can use different namespaces to avoid conflicts
   * @default 'asset-security'
   */
  namespace?: string;

  /**
   * Token configuration
   */
  tokenConfig?: {
    /**
     * Memory cache TTL in milliseconds
     * @default 300000 (5 minutes)
     */
    memoryCacheTTL?: number;

    /**
     * Refresh threshold in milliseconds
     * Token will be refreshed if expiry is within this threshold
     * @default 60000 (1 minute)
     */
    refreshThreshold?: number;
  };

  /**
   * Cache strategies for different asset types
   */
  cacheStrategies?: {
    images?: 'cache-first' | 'network-first' | 'network-only' | 'cache-only';
    tiles?: 'cache-first' | 'network-first' | 'network-only' | 'cache-only';
    documents?: 'cache-first' | 'network-first' | 'network-only' | 'cache-only';
  };

  /**
   * Service worker scope
   * @default '/'
   */
  scope?: string;

  /**
   * Service worker file path (relative to public directory)
   * @default '/sw.js'
   */
  serviceWorkerPath?: string;

  /**
   * Maximum time to wait for an active service worker to control the current page.
   * Set to 0 to continue immediately after requesting control.
   * @default 5000
   */
  serviceWorkerControlTimeout?: number;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Event listeners for security events
   */
  onTokenExpired?: () => void | Promise<void>;
  onTokenRefreshed?: (token: Token) => void;
  onRegistrationError?: (error: Error) => void;
  onSecurityEvent?: SecurityEventListener;
}


/**
 * Options for updating authentication token
 */
export interface TokenUpdateOptions {
  /**
   * The access token
   */
  accessToken: string;

  /**
   * Token expiration timestamp (milliseconds since epoch)
   * If not provided, defaults to 1 hour from now
   */
  expiresAt?: number;

  /**
   * Optional refresh token
   */
  refreshToken?: string;

  /**
   * Token scope
   */
  scope?: string;
}

/**
 * Status information about the asset security system
 */
export interface AssetSecurityStatus {
  /**
   * Whether service worker is registered and active
   */
  isRegistered: boolean;

  /**
   * Whether user is authenticated (has valid token)
   */
  isAuthenticated: boolean;

  /**
   * Service worker version
   */
  version?: string;

  /**
   * Number of cached asset requests
   */
  cachedRequests?: number;

  /**
   * Active cache names
   */
  caches?: string[];

  /**
   * Token expiration timestamp (if available)
   */
  tokenExpiresAt?: number;

  /**
   * Proxy connectivity status
   */
  proxyStatus?: 'connected' | 'disconnected' | 'unknown';
}

/**
 * Security event types
 */
export type SecurityEventType =
  | 'registration:success'
  | 'registration:error'
  | 'token:updated'
  | 'token:expired'
  | 'token:refreshed'
  | 'cache:cleared'
  | 'request:intercepted'
  | 'request:authenticated'
  | 'request:failed';

/**
 * Security event data
 */
export interface SecurityEvent {
  type: SecurityEventType;
  timestamp: number;
  data?: any;
  error?: Error;
}

/**
 * Security event listener callback
 */
export type SecurityEventListener = (event: SecurityEvent) => void;

/**
 * Registration result
 */
export interface RegistrationResult {
  success: boolean;
  registration?: ServiceWorkerRegistration;
  error?: Error;
}
