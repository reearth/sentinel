# Sentinel

A generic, framework-agnostic service worker library for securing asset access with authentication. Sentinel intercepts network requests to protected domains and automatically adds Bearer token authentication headers.

## Features

- 🔐 **Transparent Authentication**: Automatically adds auth headers to protected asset requests
- 🎯 **Customizable Patterns**: Define your own URL patterns for different asset types
- 💾 **Smart Caching**: Configurable cache strategies (cache-first, network-first, etc.)
- 🔄 **Token Management**: Hierarchical token storage (Memory → IndexedDB → Fresh)
- ⚡ **Zero Configuration Defaults**: Works out of the box with sensible defaults
- 🔧 **Fully Configurable**: Customize every aspect for your use case
- 📦 **Framework Agnostic**: Works with React, Vue, Angular, Svelte, or vanilla JS
- 🎨 **TypeScript First**: Full TypeScript support with comprehensive types

## Use Cases

- Securing cloud storage assets (GCS, S3, Azure Blob)
- Private CDN content
- Protected map tiles (MVT, raster)
- Authenticated API resources
- Secure media delivery

## Installation

```bash
npm install @reearth/sentinel
# or
yarn add @reearth/sentinel
# or
pnpm add @reearth/sentinel
```

## Quick Start

### 1. Copy Service Worker

Copy the service worker file to your `public` directory:

```bash
cp node_modules/@reearth/sentinel/dist/sw.js public/
```

### 2. Basic Setup

```typescript
import { registerAssetSecurity, updateToken } from '@reearth/sentinel';

// Initialize with minimal config
await registerAssetSecurity({
  proxyUrl: 'https://your-auth-proxy.com',
  protectedDomains: [
    'storage.googleapis.com',
    'your-cdn.example.com'
  ],

  // Optional: Handle token expiration
  onTokenExpired: async () => {
    const newToken = await yourAuthSystem.getToken();
    await updateToken({
      accessToken: newToken,
      expiresAt: Date.now() + 3600000
    });
  }
});

// Update token when user logs in
await updateToken({
  accessToken: 'your-jwt-token',
  expiresAt: Date.now() + 3600000 // 1 hour
});
```

### 3. Clear Token on Logout

```typescript
import { clearToken } from '@reearth/sentinel';

// When user logs out
await clearToken();
```

## Advanced Configuration

### Custom Asset Patterns

Define regex patterns for your specific asset types:

```typescript
await registerAssetSecurity({
  proxyUrl: 'https://proxy.example.com',
  protectedDomains: ['assets.example.com'],

  assetPatterns: {
    // Images
    customAssets: /\.(jpg|jpeg|png|gif|webp)$/i,

    // Map tiles: /tiles/{source}/{z}/{x}/{y}
    mvtTiles: /\/tiles\/[^/]+\/\d+\/\d+\/\d+\.mvt/,
    rasterTiles: /\/tiles\/[^/]+\/\d+\/\d+\/\d+\.(png|jpg)/,

    // Other assets
    generalAssets: /\.(pdf|json|geojson|svg)$/i
  }
});
```

### Custom Asset ID Extraction

If your URLs have a specific structure, provide a custom extractor:

```typescript
await registerAssetSecurity({
  proxyUrl: 'https://proxy.example.com',
  protectedDomains: ['cdn.example.com'],

  // Extract asset ID from: /content/assets/{uuid}/file.jpg
  extractAssetId: (url) => {
    const match = url.pathname.match(/\/assets\/([^/]+)\//);
    return match ? match[1] : null;
  }
});
```

### Cache Strategies

Configure caching behavior per asset type:

```typescript
await registerAssetSecurity({
  proxyUrl: 'https://proxy.example.com',
  protectedDomains: ['assets.example.com'],

  cacheStrategies: {
    images: 'cache-first',      // Try cache first, fallback to network
    tiles: 'network-first',     // Try network first, fallback to cache
    documents: 'network-only'   // Always fetch from network
  }
});
```

### Token Configuration

Customize token management:

```typescript
await registerAssetSecurity({
  proxyUrl: 'https://proxy.example.com',
  protectedDomains: ['assets.example.com'],

  tokenConfig: {
    memoryCacheTTL: 10 * 60 * 1000,    // 10 minutes in memory
    refreshThreshold: 2 * 60 * 1000     // Refresh if < 2 min remaining
  }
});
```

### Namespace Isolation

Use namespaces to isolate storage for multiple apps:

```typescript
await registerAssetSecurity({
  namespace: 'my-app',  // Creates 'my-app-auth' DB and 'my-app-v1' cache
  proxyUrl: 'https://proxy.example.com',
  protectedDomains: ['assets.example.com']
});
```

## API Reference

### `registerAssetSecurity(config)`

Initialize the service worker with your configuration.

**Parameters:**
- `config.proxyUrl` (string, required): URL of your authentication proxy
- `config.protectedDomains` (string[], required): Domains requiring auth
- `config.assetPatterns` (object, optional): Custom URL patterns
- `config.extractAssetId` (function, optional): Custom ID extractor
- `config.namespace` (string, optional): Storage namespace (default: 'asset-security')
- `config.tokenConfig` (object, optional): Token management settings
- `config.cacheStrategies` (object, optional): Cache behavior per asset type
- `config.onTokenExpired` (function, optional): Token expiration callback
- `config.onTokenRefreshed` (function, optional): Token refresh callback
- `config.onSecurityEvent` (function, optional): Generic event callback

**Returns:** `Promise<RegistrationResult>`

### `updateToken(options)`

Update the authentication token.

**Parameters:**
- `options.accessToken` (string, required): The JWT or bearer token
- `options.expiresAt` (number, optional): Expiry timestamp in ms
- `options.refreshToken` (string, optional): Refresh token
- `options.scope` (string, optional): Token scope

**Returns:** `Promise<void>`

### `clearToken()`

Remove stored authentication token.

**Returns:** `Promise<void>`

### `getSecurityStatus()`

Get current security system status.

**Returns:** `Promise<AssetSecurityStatus>`

```typescript
{
  isRegistered: boolean;
  isAuthenticated: boolean;
  version?: string;
  cachedRequests?: number;
  caches?: string[];
  tokenExpiresAt?: number;
  proxyStatus?: 'connected' | 'disconnected' | 'unknown';
}
```

### `clearCache()`

Clear all cached assets.

**Returns:** `Promise<void>`

### `unregisterAssetSecurity()`

Unregister the service worker and clean up.

**Returns:** `Promise<void>`

## Framework Examples

### React

```typescript
import { useEffect } from 'react';
import { registerAssetSecurity, updateToken, clearToken } from '@reearth/sentinel';

function App() {
  const { token, isAuthenticated } = useAuth(); // Your auth hook

  useEffect(() => {
    registerAssetSecurity({
      proxyUrl: import.meta.env.VITE_PROXY_URL,
      protectedDomains: ['storage.googleapis.com'],
      onTokenExpired: async () => {
        // Handle token refresh
      }
    });
  }, []);

  useEffect(() => {
    if (isAuthenticated && token) {
      updateToken({
        accessToken: token,
        expiresAt: Date.now() + 3600000
      });
    } else {
      clearToken();
    }
  }, [isAuthenticated, token]);

  return <YourApp />;
}
```

### Vue 3

```typescript
import { onMounted, watch } from 'vue';
import { registerAssetSecurity, updateToken, clearToken } from '@reearth/sentinel';

export default {
  setup() {
    const auth = useAuth(); // Your auth composable

    onMounted(() => {
      registerAssetSecurity({
        proxyUrl: import.meta.env.VITE_PROXY_URL,
        protectedDomains: ['storage.googleapis.com']
      });
    });

    watch(() => auth.token, (newToken) => {
      if (newToken) {
        updateToken({ accessToken: newToken });
      } else {
        clearToken();
      }
    });
  }
};
```

### Vanilla JavaScript

```javascript
import { registerAssetSecurity, updateToken } from '@reearth/sentinel';

// Initialize
registerAssetSecurity({
  proxyUrl: 'https://proxy.example.com',
  protectedDomains: ['assets.example.com']
}).then(() => {
  console.log('Asset security initialized');
});

// On login
document.getElementById('login-btn').addEventListener('click', async () => {
  const token = await yourAuthFunction();
  await updateToken({ accessToken: token });
});
```

## Architecture

```
┌─────────────────┐
│   Your App      │
│  (any framework)│
└────────┬────────┘
         │ registerAssetSecurity()
         │ updateToken()
         ▼
┌─────────────────┐
│ Service Worker  │◄──── Intercepts fetch events
│  (this library) │
└────────┬────────┘
         │ Adds auth headers
         ▼
┌─────────────────┐
│  Auth Proxy     │◄──── Validates tokens
│  (your server)  │
└────────┬────────┘
         │ Proxies request
         ▼
┌─────────────────┐
│ Protected Assets│
│  (GCS, S3, etc) │
└─────────────────┘
```

## Token Storage Hierarchy

1. **Memory Cache** (fastest, 5 min TTL)
   - In-memory storage
   - Cleared on page refresh

2. **IndexedDB** (persistent)
   - Survives page refreshes
   - Per-origin storage

3. **Fresh Request** (fallback)
   - Calls `onTokenExpired` callback
   - Requests new token from your auth system

## Browser Support

- Chrome 67+
- Firefox 63+
- Safari 11.3+
- Edge 79+

Service Workers require HTTPS (except on localhost).

## Security Considerations

- Tokens are stored in IndexedDB (encrypted by browser)
- Tokens never appear in URLs
- Service Worker scope should match your app's scope
- Use short-lived tokens with refresh capability
- Implement proper CORS on your proxy server

## Troubleshooting

### Service Worker Not Registering

```typescript
// Check registration result
const result = await registerAssetSecurity({...});
if (!result.success) {
  console.error('Registration failed:', result.error);
}
```

### Requests Not Being Intercepted

- Verify `protectedDomains` includes the asset domain
- Check browser DevTools → Application → Service Workers
- Ensure assets match `assetPatterns` regex

### Token Not Being Applied

```typescript
// Check status
const status = await getSecurityStatus();
console.log('Authenticated:', status.isAuthenticated);
console.log('Token expires:', new Date(status.tokenExpiresAt));
```

### Clear Everything and Start Fresh

```typescript
import { unregisterAssetSecurity } from '@reearth/sentinel';

await unregisterAssetSecurity();
// Then re-register
```

## Development

```bash
# Install dependencies
npm install

# Build library
npm run build

# Build service worker
npm run build:sw

# Type check
npm run type-check

# Run tests
npm test
```

## License

Apache-2.0

## Contributing

Contributions welcome! Please open an issue or PR.

## Support

- 📖 [Documentation](https://github.com/reearth/sentinel)
- 🐛 [Issue Tracker](https://github.com/reearth/sentinel/issues)
- 💬 [Discussions](https://github.com/reearth/sentinel/discussions)

