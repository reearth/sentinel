import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheFirst, networkFirst } from './strategies.js';
import { requestInterceptor } from './request-interceptor.js';
import { CACHED_AT_HEADER, withCacheStamp } from './cache-policy.js';

/** Minimal in-memory Cache/CacheStorage stand-in keyed by URL. */
function fakeCaches() {
  const store = new Map<string, Response>();
  const cache = {
    match: async (key: Request) => store.get(key.url)?.clone(),
    put: async (key: Request, resp: Response) => {
      store.set(key.url, resp);
    },
  };
  return {
    store,
    caches: { open: async () => cache } as unknown as CacheStorage,
  };
}

const TILE_URL = 'https://tiles.example.com/v1/3dtiles/datasets/a/files/x.glb?session=S';

function networkResponse(headers: Record<string, string> = {}, status = 200): Response {
  return new Response('fresh-bytes', {
    status,
    headers: { 'content-type': 'model/gltf-binary', ...headers },
  });
}

describe('cacheFirst', () => {
  let env: ReturnType<typeof fakeCaches>;

  beforeEach(() => {
    env = fakeCaches();
    vi.stubGlobal('caches', env.caches);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('serves a fresh cached response without touching the network', async () => {
    const spy = vi.spyOn(requestInterceptor, 'processRequest');
    const cached = withCacheStamp(networkResponse({ 'cache-control': 'private, max-age=14400' }));
    env.store.set('https://tiles.example.com/v1/3dtiles/datasets/a/files/x.glb', cached);

    const resp = await cacheFirst(new Request(TILE_URL));

    expect(resp.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refetches once the cached response has outlived its max-age', async () => {
    const past = Date.now() - 20 * 3600_000;
    const stale = withCacheStamp(
      networkResponse({ 'cache-control': 'private, max-age=14400' }),
      past,
    );
    env.store.set('https://tiles.example.com/v1/3dtiles/datasets/a/files/x.glb', stale);
    const spy = vi
      .spyOn(requestInterceptor, 'processRequest')
      .mockResolvedValue(networkResponse({ 'cache-control': 'private, max-age=14400' }));

    const resp = await cacheFirst(new Request(TILE_URL));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(resp.status).toBe(200);
    // Re-cached with a new stamp.
    const recached = env.store.get('https://tiles.example.com/v1/3dtiles/datasets/a/files/x.glb');
    expect(Number(recached?.headers.get(CACHED_AT_HEADER))).toBeGreaterThan(past);
  });

  it('serves the stale copy when the refetch fails', async () => {
    const stale = withCacheStamp(networkResponse(), Date.now() - 20 * 3600_000);
    env.store.set('https://tiles.example.com/v1/3dtiles/datasets/a/files/x.glb', stale);
    vi.spyOn(requestInterceptor, 'processRequest').mockRejectedValue(new Error('offline'));

    const resp = await cacheFirst(new Request(TILE_URL));

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('fresh-bytes');
  });

  it('does not store no-store responses', async () => {
    vi.spyOn(requestInterceptor, 'processRequest').mockResolvedValue(
      networkResponse({ 'cache-control': 'no-store' }),
    );

    const resp = await cacheFirst(new Request(TILE_URL));

    expect(resp.status).toBe(200);
    expect(env.store.size).toBe(0);
  });
});

describe('networkFirst', () => {
  let env: ReturnType<typeof fakeCaches>;

  beforeEach(() => {
    env = fakeCaches();
    vi.stubGlobal('caches', env.caches);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stamps and caches OK responses', async () => {
    vi.spyOn(requestInterceptor, 'processRequest').mockResolvedValue(
      networkResponse({ 'cache-control': 'private, max-age=3600' }),
    );

    await networkFirst(new Request(TILE_URL));

    const cached = env.store.get('https://tiles.example.com/v1/3dtiles/datasets/a/files/x.glb');
    expect(cached).toBeDefined();
    expect(cached?.headers.get(CACHED_AT_HEADER)).toBeTruthy();
  });

  it('does not store no-store responses', async () => {
    vi.spyOn(requestInterceptor, 'processRequest').mockResolvedValue(
      networkResponse({ 'cache-control': 'no-store' }),
    );

    await networkFirst(new Request(TILE_URL));

    expect(env.store.size).toBe(0);
  });

  it('falls back to the cached copy (even stale) on network failure', async () => {
    const stale = withCacheStamp(networkResponse(), Date.now() - 40 * 3600_000);
    env.store.set('https://tiles.example.com/v1/3dtiles/datasets/a/files/x.glb', stale);
    vi.spyOn(requestInterceptor, 'processRequest').mockRejectedValue(new Error('offline'));

    const resp = await networkFirst(new Request(TILE_URL));

    expect(resp.status).toBe(200);
  });
});
