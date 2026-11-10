import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { Token, TokenStorageEntry, TokenManager as ITokenManager } from './types';
import { debugError, debugLog, getIndexedDBName } from './config';
import { WORKER_TOKEN_WAIT_MS } from './token-provider';

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

  /** Shared in-flight fresh-token request — the SW is a single context,
   *  so concurrent intercepted requests await one round trip instead of
   *  each messaging the page separately. */
  private inFlightAcquisition: Promise<string | null> | null = null;
  private inFlightRefresh: Promise<string | null> | null = null;
  private lastAcquisitionFailureAt = 0;

  /** Every caller awaits the same open, so concurrent first requests all see the connection. */
  private db(): Promise<IDBPDatabase<AuthDB>> {
    this.dbPromise ??= openDB<AuthDB>(getIndexedDBName(), 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('tokens')) {
          db.createObjectStore('tokens');
        }
      },
    }).catch((error) => {
      // A failed open must not poison every later lookup until the worker restarts.
      this.dbPromise = null;
      throw error;
    });
    return this.dbPromise;
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
    // A token from the page ends any backoff from an earlier unanswered request.
    this.lastAcquisitionFailureAt = 0;

    // Store in IndexedDB
    try {
      await (await this.db()).put('tokens', entry, 'current');
      debugLog('[TokenManager] Token stored successfully');
    } catch (error) {
      debugError('[TokenManager] Error storing token:', error);
    }
  }

  /**
   * The server rejected the current token: ask the pages for a different
   * one. Single-flight, so a burst of 401s sends one REFRESH_TOKEN.
   */
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

  /**
   * Asks every window client and takes the first token. A tab running an
   * older library never answers and one without a token says
   * TOKEN_UNAVAILABLE; neither may stop another tab from answering.
   */
  private async askClients(
    message: { type: 'REQUEST_TOKEN' } | { type: 'REFRESH_TOKEN'; refreshToken?: string },
    accept: 'TOKEN_PROVIDED' | 'TOKEN_REFRESHED'
  ): Promise<string | null> {
    try {
      const clients: readonly Client[] = await (self as unknown as ServiceWorkerGlobalScope).clients.matchAll({ type: 'window' });
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
