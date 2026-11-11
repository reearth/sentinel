import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { Token, TokenStorageEntry, TokenManager as ITokenManager } from './types';
import { debugError, debugLog, getIndexedDBName } from './config';
import { WORKER_TOKEN_WAIT_MS } from './token-provider';

declare const self: ServiceWorkerGlobalScope;

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
  private dbPromise: Promise<IDBPDatabase<AuthDB>> | null = null;
  private dbName = '';

  /** Shared in-flight fresh-token request — the SW is a single context,
   *  so concurrent intercepted requests await one round trip instead of
   *  each messaging the page separately. */
  private inFlightAcquisition: Promise<string | null> | null = null;
  private inFlightRefresh: Promise<string | null> | null = null;
  private lastAcquisitionFailureAt = 0;

  private db(): Promise<IDBPDatabase<AuthDB>> {
    const name = getIndexedDBName();
    if (this.dbPromise && this.dbName === name) return this.dbPromise;
    this.dbPromise?.then((db) => db.close(), () => {});
    this.dbName = name;
    const forgetConnection = () => {
      if (this.dbPromise === opening) this.dbPromise = null;
    };
    const opening: Promise<IDBPDatabase<AuthDB>> = openDB<AuthDB>(name, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('tokens')) {
          db.createObjectStore('tokens');
        }
      },
      blocking: (_current, _blocked, event) => {
        forgetConnection();
        (event.target as IDBDatabase).close();
      },
      terminated: forgetConnection,
    }).catch((error) => {
      forgetConnection();
      throw error;
    });
    this.dbPromise = opening;
    return opening;
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
      const dbToken = await (await this.db()).get('tokens', 'current');

      if (dbToken && !this.isTokenExpired(dbToken)) {
        debugLog('[TokenManager] Token found in IndexedDB');
        // Update memory cache
        this.memoryCache = dbToken;
        return dbToken.token;
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
    this.lastAcquisitionFailureAt = 0;

    // Store in IndexedDB
    try {
      await (await this.db()).put('tokens', entry, 'current');
      debugLog('[TokenManager] Token stored successfully');
    } catch (error) {
      debugError('[TokenManager] Error storing token:', error);
    }
  }

  refreshToken(): Promise<string | null> {
    this.inFlightRefresh ??= this.askForRefresh().finally(() => {
      this.inFlightRefresh = null;
    });
    return this.inFlightRefresh;
  }

  private async askForRefresh(): Promise<string | null> {
    debugLog('[TokenManager] Refreshing token...');
    let refreshToken: string | undefined;
    try {
      refreshToken = (this.memoryCache ?? await (await this.db()).get('tokens', 'current'))?.refreshToken;
    } catch (error) {
      debugError('[TokenManager] Error reading the refresh token:', error);
    }
    return this.askClients({ type: 'REFRESH_TOKEN', refreshToken }, 'TOKEN_REFRESHED');
  }

  /**
   * Clear all stored tokens
   */
  async clearToken(): Promise<void> {
    this.memoryCache = null;

    try {
      await (await this.db()).delete('tokens', 'current');
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
   * Request a fresh token from the main thread — single-flight, with a
   * backoff window after an unanswered request (see
   * TOKEN_ACQUISITION_BACKOFF_MS).
   */
  private async requestFreshToken(): Promise<string | null> {
    if (Date.now() - this.lastAcquisitionFailureAt < TOKEN_ACQUISITION_BACKOFF_MS) {
      debugLog('[TokenManager] Skipping token request during backoff window');
      return null;
    }

    this.inFlightAcquisition ??= this.askClients({ type: 'REQUEST_TOKEN' }, 'TOKEN_PROVIDED')
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

  private async askClients(
    message: { type: 'REQUEST_TOKEN' } | { type: 'REFRESH_TOKEN'; refreshToken?: string },
    accept: 'TOKEN_PROVIDED' | 'TOKEN_REFRESHED'
  ): Promise<string | null> {
    try {
      const clients: readonly Client[] = await self.clients.matchAll({ type: 'window' });
      if (clients.length === 0) {
        debugLog('[TokenManager] No clients available');
        return null;
      }

      const token = await new Promise<Token | null>((resolve) => {
        let unanswered = clients.length;
        const channels: MessageChannel[] = [];
        const finish = (result: Token | null) => {
          clearTimeout(timer);
          channels.forEach((channel) => channel.port1.close());
          resolve(result);
        };
        const timer = setTimeout(() => {
          debugLog('[TokenManager] Token request timeout');
          finish(null);
        }, WORKER_TOKEN_WAIT_MS);

        for (const client of clients) {
          const channel = new MessageChannel();
          channels.push(channel);
          channel.port1.onmessage = (event) => {
            if (event.data?.type === accept && event.data.token) finish(event.data.token);
            else if (--unanswered === 0) finish(null);
          };
          client.postMessage(message, [channel.port2]);
        }
      });

      if (!token) return null;
      await this.setToken(token);
      return token.access_token;
    } catch (error) {
      debugError('[TokenManager] Error requesting token from clients:', error);
      return null;
    }
  }
}

// Export singleton instance
export const tokenManager = new TokenManager();
