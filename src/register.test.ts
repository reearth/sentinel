import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeServiceWorkerRuntime } from './test-support/sw-runtime.js';
import { decodeRuntimeConfig, toRuntimeConfig } from './runtime-config.js';

const TILE = 'https://tiles.example.com/imagery/google-satellite/15/29105/12903.webp';
const DAY = 24 * 60 * 60 * 1000;

type PageApi = typeof import('./index.js');

async function loadPage(): Promise<PageApi> {
  vi.resetModules();
  return import('./index.js');
}

const config = {
  proxyUrl: 'https://tiles.example.com',
  protectedDomains: ['tiles.example.com'],
  namespace: 'reearth-visualizer',
  assetPatterns: { rasterTiles: /\/(?:cesium-mesh|imagery|google3d|v1\/3dtiles)\// },
};

describe('registerAssetSecurity', () => {
  let rt: FakeServiceWorkerRuntime;

  beforeEach(() => {
    rt = new FakeServiceWorkerRuntime();
    rt.installPageGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers the script URL that carries the encoded config', async () => {
    const page = await loadPage();
    await page.registerAssetSecurity(config);

    const url = new URL(rt.registeredScriptURL!);
    expect(url.pathname).toBe('/sw.js');
    expect(decodeRuntimeConfig(url.search)).toEqual(
      toRuntimeConfig({ ...config, namespace: 'reearth-visualizer', debug: false })
    );
  });

  it('re-registers an existing bare /sw.js registration with the config URL', async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    expect(rt.registeredScriptURL).toBe('https://app.example.com/sw.js');

    const page = await loadPage();
    expect((await page.registerAssetSecurity(config)).success).toBe(true);
    await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });
    await rt.restart();

    expect(rt.registeredScriptURL).toContain('/sw.js?sentinel=');
    expect((await rt.fetch(TILE)).status).toBe(200);
    expect(rt.lastUpstreamAuth()).toBe(`Bearer ${rt.validToken}`);
  });

  it('accepts a deprecated extractAssetId without sending it to the worker', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const page = await loadPage();

    const result = await page.registerAssetSecurity({
      ...config,
      debug: true,
      extractAssetId: (url: URL) => url.pathname,
    });

    expect(result.success).toBe(true);
    expect(rt.toWorker.some((m) => (m as { type?: string }).type === 'CONFIG')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('extractAssetId is deprecated'));
  });

  it('registering twice with the same config keeps one worker and one token listener', async () => {
    const page = await loadPage();
    const onTokenExpired = vi.fn(async () => {
      await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });
    });
    await page.registerAssetSecurity({ ...config, onTokenExpired });
    const firstUrl = rt.registeredScriptURL;
    await page.registerAssetSecurity({ ...config, onTokenExpired });

    expect(rt.registeredScriptURL).toBe(firstUrl);

    const replies = await rt.askPage({ type: 'REQUEST_TOKEN' });
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: 'TOKEN_PROVIDED', token: { access_token: rt.validToken } });
    expect(onTokenExpired).toHaveBeenCalledTimes(1);
  });

  it('answers token requests when the page reuses an existing registration', async () => {
    const first = await loadPage();
    await first.registerAssetSecurity(config);
    const scriptUrl = rt.registeredScriptURL;

    rt.reloadPage();
    const page = await loadPage();
    await page.registerAssetSecurity(config);
    await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });

    expect(rt.registeredScriptURL).toBe(scriptUrl);
    expect(await rt.askPage({ type: 'REQUEST_TOKEN' })).toEqual([
      expect.objectContaining({ type: 'TOKEN_PROVIDED', token: expect.objectContaining({ access_token: rt.validToken }) }),
    ]);
  });
});
