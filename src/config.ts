import type { ServiceWorkerConfig, AssetType } from './types';

/**
 * Runtime configuration namespace - can be updated via updateConfig()
 */
let NAMESPACE = 'asset-security';

/**
 * Default configuration with sensible defaults
 */
const DEFAULT_CONFIG: ServiceWorkerConfig = {
  // Domains that require authentication - MUST be configured by the application
  protectedDomains: [],

  // Asset patterns that need protection - MUST be configured by the application
  // These are examples and should be customized for your use case
  assetPatterns: {
    customAssets: /\.(?:jpg|jpeg|png|gif|svg|pdf|geojson|gltf|glb|kml|czml)$/i,
    mvtTiles: /\.mvt$/i,
    rasterTiles: /\/tiles\/[^/]+\/\d+\/\d+\/\d+/,
    generalAssets: /\.(jpg|jpeg|png|gif|svg|pdf|geojson|gltf|glb|kml|czml)$/i
  },

  // Token management configuration
  token: {
    memoryCacheTTL: 5 * 60 * 1000, // 5 minutes
    indexedDBName: '', // Will be set dynamically based on namespace
    indexedDBStore: 'tokens',
    refreshThreshold: 60 * 1000, // Refresh if less than 1 minute remaining
  },

  // API endpoints - proxyEndpoint MUST be configured by the application
  api: {
    tokenEndpoint: '/api/auth/token',
    refreshEndpoint: '/api/auth/refresh',
    proxyEndpoint: '' // REQUIRED: Must be set via config
  },

  // Cache settings
  cache: {
    name: '', // Will be set dynamically based on namespace
    maxAge: 3600, // 1 hour in seconds
    strategies: {
      images: 'cache-first',
      tiles: 'network-first',
      documents: 'network-only'
    }
  },

  // Debug logging is disabled by default for production consumers
  debug: false,
};

/**
 * Mutable runtime configuration
 */
export let CONFIG: ServiceWorkerConfig = { ...DEFAULT_CONFIG };

/**
 * Update configuration with namespace and custom settings
 */
export function updateConfig(config: Partial<ServiceWorkerConfig> & { namespace?: string }) {
  // Update namespace if provided
  if (config.namespace) {
    NAMESPACE = config.namespace;
  }

  // Merge custom config with defaults
  CONFIG = {
    ...DEFAULT_CONFIG,
    ...config,
    token: {
      ...DEFAULT_CONFIG.token,
      ...config.token,
      indexedDBName: `${NAMESPACE}-auth`,
    },
    cache: {
      ...DEFAULT_CONFIG.cache,
      ...config.cache,
      name: `${NAMESPACE}-v1`,
      strategies: {
        ...DEFAULT_CONFIG.cache.strategies,
        ...config.cache?.strategies,
      },
    },
    protectedDomains: config.protectedDomains || DEFAULT_CONFIG.protectedDomains,
    assetPatterns: {
      ...DEFAULT_CONFIG.assetPatterns,
      ...config.assetPatterns,
    },
    extractAssetId: config.extractAssetId,
  };

  // Validation: warn if required config is missing
  if (CONFIG.protectedDomains.length === 0) {
    debugWarn('[ServiceWorker] Warning: No protected domains configured. Authentication will not be applied.');
  }

  if (!CONFIG.api.proxyEndpoint) {
    debugWarn('[ServiceWorker] Warning: No proxy endpoint configured. Signed URL functionality will not work.');
  }

  debugLog(`[ServiceWorker] Configuration updated with namespace: ${NAMESPACE}`, CONFIG);
}

export function isDebugEnabled(): boolean {
  return !!CONFIG.debug;
}

export function debugLog(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.log(...args);
  }
}

export function debugDebug(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.debug(...args);
  }
}

export function debugWarn(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.warn(...args);
  }
}

export function debugError(...args: unknown[]): void {
  if (isDebugEnabled()) {
    console.error(...args);
  }
}

/**
 * Get current cache name (dynamically generated)
 */
export function getCacheName(): string {
  return CONFIG.cache.name || `${NAMESPACE}-v1`;
}

/**
 * Get current IndexedDB name (dynamically generated)
 */
export function getIndexedDBName(): string {
  return CONFIG.token.indexedDBName || `${NAMESPACE}-auth`;
}

// Initialize with default namespace
updateConfig({});

/**
 * Check if a URL requires authentication
 */
export function isProtectedDomain(url: URL | string): boolean {
  const urlObj = typeof url === 'string' ? new URL(url) : url;

  return CONFIG.protectedDomains.some(domain => {
    if (domain.includes(':')) {
      // Handle domain with port
      return urlObj.host === domain;
    }
    return urlObj.hostname === domain || urlObj.hostname.includes(domain);
  });
}

/**
 * Determine the type of asset from URL
 */
export function getAssetType(url: URL | string): AssetType {
  const urlObj = typeof url === 'string' ? new URL(url) : url;
  const pathname = urlObj.pathname;

  // Check for MVT tiles pattern
  if (CONFIG.assetPatterns.mvtTiles.test(pathname)) {
    return 'tile';
  }

  // Check for raster tiles pattern (tile-server)
  if (CONFIG.assetPatterns.rasterTiles.test(pathname)) {
    return 'tile';
  }

  // Check for custom assets pattern
  if (CONFIG.assetPatterns.customAssets.test(pathname)) {
    return 'asset';
  }

  // Check for general assets with extensions
  if (CONFIG.assetPatterns.generalAssets.test(pathname)) {
    const ext = pathname.split('.').pop()?.toLowerCase();
    if (ext && ['jpg', 'jpeg', 'png', 'gif', 'svg'].includes(ext)) {
      return 'image';
    }
    return 'document';
  }

  return 'unknown';
}

/**
 * Extract asset UUID from URL path
 */
export function extractAssetUUID(url: URL | string): string | null {
  const urlObj = typeof url === 'string' ? new URL(url) : url;

  // Use custom extractor if provided
  if (CONFIG.extractAssetId) {
    return CONFIG.extractAssetId(urlObj);
  }

  // Default behavior: extract UUID-like patterns from path
  const pathname = urlObj.pathname;

  // Pattern: any UUID-like string (8-4-4-4-12 hex digits)
  const uuidMatch = pathname.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
  if (uuidMatch) {
    return uuidMatch[1];
  }

  // Fallback: try to extract any hex-like ID
  const hexMatch = pathname.match(/\/([0-9a-fA-F-]{20,})\//);
  if (hexMatch) {
    return hexMatch[1];
  }

  return null;
}

/**
 * Check if request should use cache strategy
 */
export function getCacheStrategy(assetType: AssetType): string {
  switch (assetType) {
    case 'image':
      return CONFIG.cache.strategies.images;
    case 'tile':
      return CONFIG.cache.strategies.tiles;
    case 'document':
      return CONFIG.cache.strategies.documents;
    default:
      return 'network-first';
  }
}

/**
 * Get cache key for request
 */
export function getCacheKey(request: Request): Request {
  // Remove auth headers from cache key
  const url = new URL(request.url);
  const cacheUrl = url.origin + url.pathname; // Exclude query params for cache

  return new Request(cacheUrl, {
    method: request.method,
    headers: {
      'Accept': request.headers.get('Accept') || '*/*',
      'Content-Type': request.headers.get('Content-Type') || ''
    }
  });
}
