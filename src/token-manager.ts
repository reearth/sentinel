import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { Token, TokenStorageEntry, TokenManager as ITokenManager } from './types';
import { CONFIG, debugError, debugLog, getIndexedDBName } from './config';

interface AuthDB extends DBSchema {
  tokens: {
    key: string;
    value: TokenStorageEntry;
  };
}

/**
 * After a fresh-token request to the page goes unanswered, don't ask
 * again for this long. A tokenless viewer session otherwise re-runs the
 * REQUEST_TOKEN round trip (with its 5s timeout) once per intercepted
 * request — a tile burst turns that into hundreds of parallel messages
 * and stalled requests.
 */
export const TOKEN_ACQUISITION_BACKOFF_MS = 15_000;

export class TokenManager implements ITokenManager {
  private memoryCache: TokenStorageEntry | null = null;
  private db: IDBPDatabase<AuthDB> | null = null;
  private dbPromise: Promise<IDBPDatabase<AuthDB>> | null = null;

  /** Shared in-flight fresh-token request — the SW is a single context,
   *  so concurrent intercepted requests await one round trip instead of
   *  each messaging the page separately. */
  private inFlightAcquisition: Promise<string | null> | null = null;
  private lastAcquisitionFailureAt = 0;

  constructor() {
    // Don't initialize DB in constructor - let it be lazy loaded
    // This ensures config/namespace is set first
  }

  /**
   * Initialize IndexedDB connection
   */
  private async initDB(): Promise<void> {
    if (this.dbPromise) return;

    this.dbPromise = openDB<AuthDB>(getIndexedDBName(), 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('tokens')) {
          db.createObjectStore('tokens');
        }
      },
    });

    this.db = await this.dbPromise;
  }

  /**
   * Get token following the hierarchy: Memory -> IndexedDB -> Fresh request
   */
  async getToken(): Promise<string | null> {
    debugLog('[TokenManager] Getting token...');

    // 1. Check memory cache
    if (this.memoryCache && !this.isTokenExpired(this.memoryCache)) {
      debugLog('[TokenManager] Token found in memory cache');
      return this.memoryCache.token;
    }

    // 2. Check IndexedDB
    try {
      await this.initDB();
      const dbToken = await this.db!.get('tokens', 'current');

      if (dbToken && !this.isTokenExpired(dbToken)) {
        debugLog('[TokenManager] Token found in IndexedDB');
        // Update memory cache
        this.memoryCache = dbToken;
        return dbToken.token;
      }

      // Check if token needs refresh
      if (dbToken && this.shouldRefresh(dbToken)) {
        debugLog('[TokenManager] Token needs refresh');
        return await this.refreshToken();
      }
    } catch (error) {
      debugError('[TokenManager] Error accessing IndexedDB:', error);
    }

    // 3. Request fresh token from main thread
    debugLog('[TokenManager] Requesting fresh token from main thread');
    return await this.requestFreshToken();
  }

  /**
   * Store token in both memory and IndexedDB
   */
  async setToken(token: Token): Promise<void> {
    const entry: TokenStorageEntry = {
      token: token.access_token,
      expiry: token.expires_at,
      refreshToken: token.refresh_token
    };

    // Update memory cache
    this.memoryCache = entry;

    // Store in IndexedDB
    try {
      await this.initDB();
      await this.db!.put('tokens', entry, 'current');
      debugLog('[TokenManager] Token stored successfully');
    } catch (error) {
      debugError('[TokenManager] Error storing token:', error);
    }
  }

  /**
   * Refresh token using refresh token
   */
  async refreshToken(): Promise<string | null> {
    debugLog('[TokenManager] Refreshing token...');

    try {
      // Get current token with refresh token
      const current = this.memoryCache || await this.db?.get('tokens', 'current');

      if (!current?.refreshToken) {
        debugLog('[TokenManager] No refresh token available');
        return await this.requestFreshToken();
      }

      // Send message to main thread to refresh token
      const clients = await (self as any).clients.matchAll();
      if (clients.length === 0) {
        debugLog('[TokenManager] No clients available for token refresh');
        return null;
      }

      return new Promise((resolve) => {
        const messageChannel = new MessageChannel();

        messageChannel.port1.onmessage = async (event) => {
          if (event.data.type === 'TOKEN_REFRESHED' && event.data.token) {
            await this.setToken(event.data.token);
            resolve(event.data.token.access_token);
          } else {
            resolve(null);
          }
        };

        clients[0].postMessage(
          {
            type: 'REFRESH_TOKEN',
            refreshToken: current.refreshToken
          },
          [messageChannel.port2]
        );

        // Timeout after 5 seconds
        setTimeout(() => resolve(null), 5000);
      });
    } catch (error) {
      debugError('[TokenManager] Error refreshing token:', error);
      return null;
    }
  }

  /**
   * Clear all stored tokens
   */
  async clearToken(): Promise<void> {
    this.memoryCache = null;

    try {
      await this.initDB();
      await this.db!.delete('tokens', 'current');
      debugLog('[TokenManager] Tokens cleared');
    } catch (error) {
      debugError('[TokenManager] Error clearing tokens:', error);
    }
  }

  /**
   * Check if token is expired
   */
  isTokenExpired(entry?: TokenStorageEntry): boolean {
    if (!entry) return true;

    const now = Date.now();
    return now >= entry.expiry;
  }

  /**
   * Check if token should be refreshed (approaching expiry)
   */
  private shouldRefresh(entry: TokenStorageEntry): boolean {
    const now = Date.now();
    const timeUntilExpiry = entry.expiry - now;
    return timeUntilExpiry <= CONFIG.token.refreshThreshold;
  }

  /**
   * Request a fresh token from the main thread — single-flight, with a
   * backoff window after an unanswered request (see
   * TOKEN_ACQUISITION_BACKOFF_MS).
   */
  private async requestFreshToken(): Promise<string | null> {
    if (Date.now() - this.lastAcquisitionFailureAt < TOKEN_ACQUISITION_BACKOFF_MS) {
      debugLog('[TokenManager] Skipping token request during backoff window');
      return null;
    }

    this.inFlightAcquisition ??= this.requestTokenFromClients()
      .then((token) => {
        if (!token) {
          this.lastAcquisitionFailureAt = Date.now();
        }
        return token;
      })
      .finally(() => {
        this.inFlightAcquisition = null;
      });

    return this.inFlightAcquisition;
  }

  private async requestTokenFromClients(): Promise<string | null> {
    try {
      const clients = await (self as any).clients.matchAll();
      if (clients.length === 0) {
        debugLog('[TokenManager] No clients available');
        return null;
      }

      return new Promise((resolve) => {
        const messageChannel = new MessageChannel();

        messageChannel.port1.onmessage = async (event) => {
          if (event.data.type === 'TOKEN_PROVIDED' && event.data.token) {
            await this.setToken(event.data.token);
            resolve(event.data.token.access_token);
          } else {
            resolve(null);
          }
        };

        clients[0].postMessage(
          { type: 'REQUEST_TOKEN' },
          [messageChannel.port2]
        );

        // Timeout after 5 seconds
        setTimeout(() => {
          debugLog('[TokenManager] Token request timeout');
          resolve(null);
        }, 5000);
      });
    } catch (error) {
      debugError('[TokenManager] Error requesting fresh token:', error);
      return null;
    }
  }
}

// Export singleton instance
export const tokenManager = new TokenManager();
