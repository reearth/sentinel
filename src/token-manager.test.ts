import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fakeIndexedDB from 'fake-indexeddb';
import { openDB } from 'idb';
import { TokenManager, TOKEN_ACQUISITION_BACKOFF_MS } from './token-manager.js';

/**
 * Fake SW clients list. `respond` controls whether the page answers the
 * REQUEST_TOKEN message (and with what), mimicking the main thread.
 */
function fakeClients(respond: 'token' | 'silent') {
  const postMessage = vi.fn((message: { type?: string }, ports?: MessagePort[]) => {
    if (respond === 'token' && message.type === 'REQUEST_TOKEN' && ports?.[0]) {
      ports[0].postMessage({
        type: 'TOKEN_PROVIDED',
        token: {
          access_token: 'tok-123',
          expires_at: Date.now() + 3600_000,
        },
      });
    }
    // 'silent': never reply — the SW's 5s timeout fires.
  });
  return {
    postMessage,
    clients: { matchAll: async () => [{ postMessage }] },
  };
}

describe('TokenManager fresh-token acquisition', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('concurrent requests share a single REQUEST_TOKEN round trip', async () => {
    const fake = fakeClients('token');
    vi.stubGlobal('self', { clients: fake.clients });

    const tm = new TokenManager();
    const [a, b, c] = await Promise.all([tm.getToken(), tm.getToken(), tm.getToken()]);

    expect(a).toBe('tok-123');
    expect(b).toBe('tok-123');
    expect(c).toBe('tok-123');
    expect(fake.postMessage).toHaveBeenCalledTimes(1);
  });

  it('backs off after a failed acquisition instead of re-asking per request', async () => {
    const fake = fakeClients('silent');
    vi.stubGlobal('self', { clients: fake.clients });

    const tm = new TokenManager();
    const first = tm.getToken();
    await vi.advanceTimersByTimeAsync(5_000); // provider timeout
    expect(await first).toBeNull();
    expect(fake.postMessage).toHaveBeenCalledTimes(1);

    // Within the backoff window: fail fast, no new message, no 5s stall.
    const second = await tm.getToken();
    expect(second).toBeNull();
    expect(fake.postMessage).toHaveBeenCalledTimes(1);

    // After the window lapses we ask again.
    await vi.advanceTimersByTimeAsync(TOKEN_ACQUISITION_BACKOFF_MS);
    const third = tm.getToken();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await third).toBeNull();
    expect(fake.postMessage).toHaveBeenCalledTimes(2);
  });

  it('a failed token-store open is retried on the next lookup instead of failing forever', async () => {
    vi.useRealTimers();
    for (const name of ['IDBCursor', 'IDBCursorWithValue', 'IDBDatabase', 'IDBFactory', 'IDBIndex',
      'IDBKeyRange', 'IDBObjectStore', 'IDBOpenDBRequest', 'IDBRequest', 'IDBTransaction',
      'IDBVersionChangeEvent'] as const) {
      vi.stubGlobal(name, fakeIndexedDB[name]);
    }
    const factory = new fakeIndexedDB.IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    const seeded = await openDB('asset-security-auth', 1, {
      upgrade: (db) => db.createObjectStore('tokens'),
    });
    await seeded.put('tokens', { token: 'tok-stored', expiry: Date.now() + 3600_000 }, 'current');
    seeded.close();
    (await openDB('asset-security-newer', 2)).close();

    let opens = 0;
    vi.stubGlobal('indexedDB', {
      open: (name: string, version?: number) =>
        opens++ === 0 ? factory.open('asset-security-newer', 1) : factory.open(name, version),
    });
    vi.stubGlobal('self', { clients: { matchAll: async () => [] } });

    const tm = new TokenManager();
    expect(await tm.getToken()).toBeNull();
    expect(await tm.getToken()).toBe('tok-stored');
  });

  it('a provided token is served from memory afterwards — no further messages', async () => {
    const fake = fakeClients('token');
    vi.stubGlobal('self', { clients: fake.clients });

    const tm = new TokenManager();
    expect(await tm.getToken()).toBe('tok-123');
    expect(await tm.getToken()).toBe('tok-123');
    expect(fake.postMessage).toHaveBeenCalledTimes(1);
  });
});
