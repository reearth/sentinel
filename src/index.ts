// Re:Earth CMS Asset Security - Main Library Entry Point
// This is the public API that CMS will import and use

export { registerAssetSecurity, unregisterAssetSecurity } from './register.js';
export { updateToken, clearToken, getSecurityStatus } from './client.js';
export type {
  AssetSecurityConfig,
  AssetSecurityStatus,
  TokenUpdateOptions,
  SecurityEventListener,
} from './public-types.js';

// Re-export types that consumers might need
export type { Token, AssetType } from './types.js';
