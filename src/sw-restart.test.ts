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
});
