import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeServiceWorkerRuntime } from './test-support/sw-runtime.js';

const TILE = 'https://tiles.example.com/imagery/google-satellite/15/29105/12903.webp';
const DAY = 24 * 60 * 60 * 1000;

type PageApi = typeof import('./index.js');

async function loadPage(): Promise<PageApi> {
  vi.resetModules();
  return import('./index.js');
}

function visualizerConfig(onTokenExpired?: () => Promise<void>) {
  return {
    proxyUrl: 'https://tiles.example.com',
    protectedDomains: ['tiles.example.com'],
    namespace: 'reearth-visualizer',
    assetPatterns: { rasterTiles: /\/(?:cesium-mesh|imagery|google3d|v1\/3dtiles)\// },
    tokenConfig: { memoryCacheTTL: 300_000, refreshThreshold: 60_000 },
    onTokenExpired,
  };
}

describe('protected tile requests stay authenticated', () => {
  let rt: FakeServiceWorkerRuntime;

  beforeEach(() => {
    rt = new FakeServiceWorkerRuntime();
    rt.installPageGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('after the browser restarts an idle service worker', async () => {
    const page = await loadPage();
    expect((await page.registerAssetSecurity(visualizerConfig())).success).toBe(true);
    expect(await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY })).toBe(true);

    expect((await rt.fetch(TILE)).status).toBe(200);

    await rt.restart();

    const resp = await rt.fetch(TILE);
    expect(rt.lastUpstreamAuth()).toBe(`Bearer ${rt.validToken}`);
    expect(resp.status).toBe(200);
  });

  it('when the worker has no valid token, the page supplies one instead of the request going out unauthenticated', async () => {
    const page = await loadPage();
    const onTokenExpired = vi.fn(async () => {
      await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });
    });
    await page.registerAssetSecurity(visualizerConfig(onTokenExpired));
    await page.updateToken({ accessToken: 'tok-stale', expiresAt: Date.now() - 1 });

    const started = Date.now();
    const resp = await rt.fetch(TILE);

    expect(onTokenExpired).toHaveBeenCalled();
    expect(rt.lastUpstreamAuth()).toBe(`Bearer ${rt.validToken}`);
    expect(resp.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
  }, 15_000);

  it('a tab that never answers token requests does not stall the one that does', async () => {
    rt.addClient('silent', 'front');
    const page = await loadPage();
    const onTokenExpired = vi.fn(async () => {
      await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });
    });
    await page.registerAssetSecurity(visualizerConfig(onTokenExpired));
    await page.updateToken({ accessToken: 'tok-stale', expiresAt: Date.now() - 1 });
    await rt.restart();

    const started = Date.now();
    const resp = await rt.fetch(TILE);

    expect(resp.status).toBe(200);
    expect(rt.lastUpstreamAuth()).toBe(`Bearer ${rt.validToken}`);
    expect(Date.now() - started).toBeLessThan(1000);
  }, 15_000);

  it('after a page reload reuses the existing registration, then the worker restarts', async () => {
    const first = await loadPage();
    await first.registerAssetSecurity(visualizerConfig());
    await first.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });

    rt.reloadPage();
    const page = await loadPage();
    const onTokenExpired = vi.fn(async () => {
      await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });
    });
    expect((await page.registerAssetSecurity(visualizerConfig(onTokenExpired))).success).toBe(true);

    await rt.restart();
    expect((await rt.fetch(TILE)).status).toBe(200);
    expect(rt.lastUpstreamAuth()).toBe(`Bearer ${rt.validToken}`);

    await page.updateToken({ accessToken: 'tok-stale', expiresAt: Date.now() - 1 });
    await rt.restart();
    expect((await rt.fetch(TILE)).status).toBe(200);
    expect(onTokenExpired).toHaveBeenCalled();
  }, 15_000);

  it('when the server rejects an unexpired token, the page renews it and the tile is retried', async () => {
    const page = await loadPage();
    const onTokenExpired = vi.fn(async () => {
      await page.updateToken({ accessToken: 'tok-rotated', expiresAt: Date.now() + DAY });
    });
    await page.registerAssetSecurity(visualizerConfig(onTokenExpired));
    await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });
    rt.validToken = 'tok-rotated';

    const resp = await rt.fetch(TILE);

    expect(onTokenExpired).toHaveBeenCalledTimes(1);
    expect(rt.lastUpstreamAuth()).toBe('Bearer tok-rotated');
    expect(resp.status).toBe(200);
  });

  it('does not attach the token to hosts outside protectedDomains, before or after a restart', async () => {
    const page = await loadPage();
    await page.registerAssetSecurity(visualizerConfig());
    await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });

    await rt.fetch('https://a.tile.openstreetmap.org/imagery/1/1/1.png');
    expect(rt.lastUpstreamAuth()).toBeNull();

    await rt.restart();
    await rt.fetch('https://a.tile.openstreetmap.org/imagery/1/1/1.png');
    expect(rt.lastUpstreamAuth()).toBeNull();
  });

  it('a burst of tile requests after a restart opens the token store once and never asks the page', async () => {
    const page = await loadPage();
    await page.registerAssetSecurity(visualizerConfig());
    await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });

    await rt.restart();
    const opensBefore = rt.idbOpens;
    const tiles = Array.from({ length: 50 }, (_, i) => TILE.replace('12903', String(i)));
    const responses = await Promise.all(tiles.map((tile) => rt.fetch(tile)));

    expect(responses.map((r) => r.status)).toEqual(tiles.map(() => 200));
    expect(rt.idbOpens - opensBefore).toBe(1);
    expect(rt.toPage.filter((m) => (m as { type?: string }).type === 'REQUEST_TOKEN')).toEqual([]);
  });
});

describe('pages on an older library, which configure the worker by CONFIG message', () => {
  let rt: FakeServiceWorkerRuntime;

  beforeEach(() => {
    rt = new FakeServiceWorkerRuntime();
    rt.installPageGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function oldLibraryPageLoad(namespace = 'reearth-visualizer') {
    const active = (await navigator.serviceWorker.getRegistration())!.active!;
    active.postMessage({
      type: 'CONFIG',
      payload: {
        namespace,
        protectedDomains: ['tiles.example.com'],
        assetPatterns: { rasterTiles: /\/(?:cesium-mesh|imagery|google3d|v1\/3dtiles)\// },
        tokenConfig: { memoryCacheTTL: 300_000, refreshThreshold: 60_000 },
        cacheStrategies: undefined,
        api: { proxyEndpoint: 'https://tiles.example.com' },
        debug: false,
      },
    });
    active.postMessage(
      { type: 'UPDATE_TOKEN', payload: { token: { access_token: rt.validToken, expires_at: Date.now() + DAY } } },
      [new MessageChannel().port2]
    );
    await rt.waitUntilsSettled();
  }

  it('a bare /sw.js updated to this worker is configured by the old page and authenticates tiles', async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    await rt.updateCheck();
    expect(rt.activeScriptURL).toBe('https://app.example.com/sw.js');

    await oldLibraryPageLoad();

    expect((await rt.fetch(TILE)).status).toBe(200);
    expect(rt.lastUpstreamAuth()).toBe(`Bearer ${rt.validToken}`);
  });

  it('a worker configured by its script URL ignores CONFIG messages', async () => {
    const page = await loadPage();
    await page.registerAssetSecurity(visualizerConfig());
    await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });

    await oldLibraryPageLoad('someone-else');

    expect((await rt.fetch(TILE)).status).toBe(200);
    expect(rt.lastUpstreamAuth()).toBe(`Bearer ${rt.validToken}`);
  });

  it('warns even without debug when the script URL carries a config it cannot read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await navigator.serviceWorker.register('/sw.js?sentinel=not-a-config', { scope: '/' });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sentinel'));
  });
});
