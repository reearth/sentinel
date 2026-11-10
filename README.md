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

`registerAssetSecurity()` resolves after the service worker is active and has been asked to control the current page. Always await it before starting protected asset or tile requests so hard reloads do not bypass the service worker.

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
    refreshThreshold: 2 * 60 * 1000     // Refresh if < 2 min remaining
  }
});
```

`tokenConfig.memoryCacheTTL` is ignored: the service worker keeps a token in memory until it expires. `refreshThreshold` must be a finite number; anything else fails registration.

### Namespace Isolation

Use namespaces to isolate storage for multiple apps:

```typescript
await registerAssetSecurity({
  namespace: 'my-app',  // Creates 'my-app-auth' DB and 'my-app-v1' cache
  proxyUrl: 'https://proxy.example.com',
  protectedDomains: ['assets.example.com']
});
```

When a new worker activates, it deletes only earlier cache versions of its own namespace (`my-app-v0` and so on). Other caches on the origin are left alone.

### Service Worker Control Timeout

Sentinel waits up to 5 seconds for an active service worker to control the current page. You can tune this startup wait if your app needs a shorter or longer guardrail:

```typescript
await registerAssetSecurity({
  proxyUrl: 'https://proxy.example.com',
  protectedDomains: ['assets.example.com'],
  serviceWorkerControlTimeout: 3000
});
```

## API Reference

### `registerAssetSecurity(config)`

Initialize the service worker with your configuration.

The promise resolves once the service worker is registered, configured, and controlling the current page when the browser allows it. Sentinel sends an internal `CLAIM_CLIENTS` message to handle hard reloads where `navigator.serviceWorker.controller` can be `null`; if control is not gained within `serviceWorkerControlTimeout`, registration continues and logs a warning in debug mode.

The configuration travels in the service worker's script URL (`/sw.js?sentinel=...`), so it survives the browser stopping an idle worker. Registering again with the same configuration keeps the running worker; a changed configuration installs a new one. Serve `sw.js` for that path regardless of its query string.

Registration fails, through `onRegistrationError` and `success: false`, when the configuration cannot be encoded for the worker, or when the new worker fails to install or does not activate within `serviceWorkerControlTimeout`. If a worker with the same configuration is already active, for example because another tab registered it first, registration succeeds.

When the service worker has no valid token, it asks every open tab of the app and uses the first token it gets. A page answers with the latest token passed to `updateToken()`, or calls `onTokenExpired` once and answers with the token that callback sets. If `onTokenExpired` throws or takes longer than 3 seconds, the page answers that it has no token. If no tab answers within 5 seconds, the request continues without a token.

When the server rejects a token with 401 or 403, the service worker asks the pages for a different one. The page then always calls `onTokenExpired`, even if its own token has not expired, and answers only with a token other than the one it had. The request is retried once with that token.

**Parameters:**
- `config.proxyUrl` (string, required): URL of your authentication proxy
- `config.protectedDomains` (string[], required): Domains requiring auth. An entry matches that host and its subdomains, so `example.com` covers `tiles.example.com` but not `example.com.attacker.net`. An entry with a port, such as `localhost:8080`, matches that host and port only
- `config.assetPatterns` (object, optional): Custom URL patterns
- `config.extractAssetId` (function, deprecated): Ignored. Functions cannot be sent to the service worker
- `config.namespace` (string, optional): Storage namespace (default: 'asset-security')
- `config.tokenConfig` (object, optional): Token management settings
- `config.cacheStrategies` (object, optional): Cache behavior per asset type
- `config.serviceWorkerControlTimeout` (number, optional): Max wait in ms for the service worker to control the current page (default: 5000)
- `config.debug` (boolean, optional): Enable debug logging for registration, service worker, token manager, and request interceptor logs (default: `false`)
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
    let cancelled = false;

    async function setupSecurity() {
      const result = await registerAssetSecurity({
        proxyUrl: import.meta.env.VITE_PROXY_URL,
        protectedDomains: ['storage.googleapis.com'],
        onTokenExpired: async () => {
          // Handle token refresh
        }
      });

      if (!result.success || cancelled) return;

      if (isAuthenticated && token) {
        await updateToken({
          accessToken: token,
          expiresAt: Date.now() + 3600000
        });
      } else {
        await clearToken();
      }
    }

    setupSecurity();

    return () => {
      cancelled = true;
    };
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

    onMounted(async () => {
      const result = await registerAssetSecurity({
        proxyUrl: import.meta.env.VITE_PROXY_URL,
        protectedDomains: ['storage.googleapis.com']
      });

      if (result.success && auth.token) {
        await updateToken({ accessToken: auth.token });
      }
    });

    watch(() => auth.token, async (newToken) => {
      if (newToken) {
        await updateToken({ accessToken: newToken });
      } else {
        await clearToken();
      }
    });
  }
};
```

### Vanilla JavaScript

```javascript
import { registerAssetSecurity, updateToken } from '@reearth/sentinel';

// Initialize before starting protected asset requests
await registerAssetSecurity({
  proxyUrl: 'https://proxy.example.com',
  protectedDomains: ['assets.example.com']
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

1. **Memory Cache** (fastest)
   - In-memory storage in the service worker, kept until the token expires
   - Cleared when the browser stops the idle worker

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
- Await `registerAssetSecurity()` before rendering views that start protected requests
- If requests fail only after a hard reload, deploy the latest `sw.js` so the worker can handle the internal `CLAIM_CLIENTS` message and call `clients.claim()`

### Token Not Being Applied

```typescript
// Check status
const status = await getSecurityStatus();
console.log('Authenticated:', status.isAuthenticated);
console.log('Token expires:', new Date(status.tokenExpiresAt));
```

### Enable Debug Logs

```typescript
await registerAssetSecurity({
  proxyUrl: 'https://proxy.example.com',
  protectedDomains: ['assets.example.com'],
  debug: true,
});
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
