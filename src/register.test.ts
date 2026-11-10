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
});
