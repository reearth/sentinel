// Type definitions for Generic Asset Security Service Worker

export interface Token {
  access_token: string;
  expires_at: number;
  refresh_token?: string;
  scope?: string;
}

export interface TokenStorageEntry {
  token: string;
  expiry: number;
  refreshToken?: string;
}

export interface AssetRequest {
  url: string;
  method: string;
  headers: Headers;
  isPrivate: boolean;
  assetType: AssetType;
  assetId?: string;
}

export type AssetType = 'image' | 'tile' | 'document' | 'asset' | 'unknown';

export interface ProxyResponse {
  signedUrl: string;
  expiry: number;
  prefix?: string;
}

export interface ServiceWorkerConfig {
  protectedDomains: string[];
  assetPatterns: {
    customAssets: RegExp;
    mvtTiles: RegExp;
    rasterTiles: RegExp;
    generalAssets: RegExp;
  };
  token: {
    memoryCacheTTL: number;
    indexedDBName: string;
    indexedDBStore: string;
    refreshThreshold: number;
  };
  api: {
    tokenEndpoint: string;
    refreshEndpoint: string;
    proxyEndpoint: string;
  };
  cache: {
    name: string;
    maxAge: number;
    strategies: {
      images: CacheStrategy;
      tiles: CacheStrategy;
      documents: CacheStrategy;
    };
  };
  extractAssetId?: (url: URL) => string | null;
}

export type CacheStrategy = 'cache-first' | 'network-first' | 'network-only' | 'cache-only';

export interface SignedUrlRequest {
  assetId: string;
  prefix?: string;
  expiry?: number;
}

export interface SignedUrlResponse {
  url: string;
  expires_at: number;
  method?: 'GET' | 'PUT';
}

export interface AssetMetadata {
  id: string;
  projectId: string;
  workspaceId: string;
  isPrivate: boolean;
  contentType?: string;
  size?: number;
}

export interface ServiceWorkerMessage {
  type: MessageType;
  payload?: any;
}

export type MessageType =
  | 'CONFIG'
  | 'UPDATE_TOKEN'
  | 'REQUEST_TOKEN'
  | 'CLEAR_CACHE'
  | 'GET_STATUS'
  | 'CLAIM_CLIENTS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REFRESHED'
  | 'TOKEN_PROVIDED'
  | 'REFRESH_TOKEN';

export interface TokenManager {
  getToken(): Promise<string | null>;
  setToken(token: Token): Promise<void>;
  refreshToken(): Promise<string | null>;
  clearToken(): Promise<void>;
  isTokenExpired(token?: TokenStorageEntry): boolean;
}

export interface RequestInterceptor {
  shouldIntercept(request: Request): boolean;
  addAuthentication(request: Request, token: string): Request;
  handleAuthError(request: Request): Promise<Response>;
}

export interface CacheManager {
  get(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
  clear(): Promise<void>;
}
