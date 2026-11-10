import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fakeIndexedDB from 'fake-indexeddb';
import { openDB } from 'idb';
import { TokenManager, TOKEN_ACQUISITION_BACKOFF_MS } from './token-manager.js';
import { WORKER_TOKEN_WAIT_MS } from './token-provider.js';

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

type Answer = 'token' | 'silent' | 'unavailable';

/** A window client that answers the worker's token messages the way `answer` says. */
function windowClient(answer: Answer, accessToken = 'tok-123') {
  return {
    type: 'window',
    postMessage: vi.fn((message: { type?: string }, ports?: MessagePort[]) => {
      const reply = message.type === 'REFRESH_TOKEN' ? 'TOKEN_REFRESHED' : 'TOKEN_PROVIDED';
      if (answer === 'token') {
        ports?.[0]?.postMessage({ type: reply, token: { access_token: accessToken, expires_at: Date.now() + 3600_000 } });
      } else if (answer === 'unavailable') {
        ports?.[0]?.postMessage({ type: 'TOKEN_UNAVAILABLE' });
      }
    }),
  };
}

describe('TokenManager asks every window client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each<[string, Answer]>([
    ['never answers', 'silent'],
    ['answers TOKEN_UNAVAILABLE', 'unavailable'],
  ])('takes the token from the second tab when the first %s', async (_label, first) => {
    vi.useFakeTimers();
    const clients = [windowClient(first), windowClient('token')];
    const matchAll = vi.fn(async () => clients);
    vi.stubGlobal('self', { clients: { matchAll } });

    expect(await new TokenManager().getToken()).toBe('tok-123');
    expect(matchAll).toHaveBeenCalledWith({ type: 'window' });
  });

  it('gives up at the overall deadline when no tab answers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('self', { clients: { matchAll: async () => [windowClient('silent'), windowClient('silent')] } });

    let token: string | null | undefined;
    new TokenManager().getToken().then((t) => (token = t));
    await vi.advanceTimersByTimeAsync(WORKER_TOKEN_WAIT_MS - 1);
    expect(token).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(token).toBeNull();
  });

  it('TOKEN_UNAVAILABLE from every tab ends the wait at once', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('self', { clients: { matchAll: async () => [windowClient('unavailable'), windowClient('unavailable')] } });

    expect(await new TokenManager().getToken()).toBeNull();
  });

  it('concurrent refreshes share one REFRESH_TOKEN round trip', async () => {
    const client = windowClient('token', 'tok-new');
    vi.stubGlobal('self', { clients: { matchAll: async () => [client] } });

    const tm = new TokenManager();
    const tokens = await Promise.all([tm.refreshToken(), tm.refreshToken(), tm.refreshToken()]);

    expect(tokens).toEqual(['tok-new', 'tok-new', 'tok-new']);
    expect(client.postMessage).toHaveBeenCalledTimes(1);
  });
});

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

  it('a token from the page ends the backoff window', async () => {
    let answer: Answer = 'silent';
    const postMessage = vi.fn((message: { type?: string }, ports?: MessagePort[]) =>
      windowClient(answer).postMessage(message, ports)
    );
    vi.stubGlobal('self', { clients: { matchAll: async () => [{ postMessage }] } });

    const tm = new TokenManager();
    const first = tm.getToken();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toBeNull();

    vi.useRealTimers();
    await tm.setToken({ access_token: 'tok-short', expires_at: Date.now() + 20 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    answer = 'token';

    expect(await tm.getToken()).toBe('tok-123');
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

describe('TokenManager token store connection', () => {
  const IDB_INTERFACES = ['IDBCursor', 'IDBCursorWithValue', 'IDBDatabase', 'IDBFactory', 'IDBIndex',
    'IDBKeyRange', 'IDBObjectStore', 'IDBOpenDBRequest', 'IDBRequest', 'IDBTransaction',
    'IDBVersionChangeEvent'] as const;
  let connections: IDBDatabase[];

  beforeEach(() => {
    for (const name of IDB_INTERFACES) vi.stubGlobal(name, fakeIndexedDB[name]);
    const factory = new fakeIndexedDB.IDBFactory();
    const open = factory.open.bind(factory);
    connections = [];
    factory.open = (name: string, version?: number) => {
      const request = open(name, version);
      request.addEventListener('success', () => connections.push(request.result));
      return request;
    };
    vi.stubGlobal('indexedDB', factory);
    vi.stubGlobal('self', { clients: { matchAll: async () => [] } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reopens after the browser closes the connection', async () => {
    const tm = new TokenManager();
    await tm.setToken({ access_token: 'tok-1', expires_at: Date.now() + 3600_000 });
    // fake-indexeddb types the parameter as the IDBDatabase constructor.
    fakeIndexedDB.forceCloseDatabase(connections[0] as unknown as typeof IDBDatabase);

    await tm.setToken({ access_token: 'tok-2', expires_at: Date.now() + 3600_000 });

    expect(await new TokenManager().getToken()).toBe('tok-2');
  });

  it('closes its connection instead of blocking a newer version of the store', async () => {
    const tm = new TokenManager();
    await tm.setToken({ access_token: 'tok-1', expires_at: Date.now() + 3600_000 });

    const upgraded = openDB('asset-security-auth', 2);
    const outcome = await Promise.race([
      upgraded.then(() => 'opened'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 200)),
    ]);

    expect(outcome).toBe('opened');
    (await upgraded).close();
  });
});
