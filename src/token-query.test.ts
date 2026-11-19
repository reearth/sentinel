import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeServiceWorkerRuntime } from './test-support/sw-runtime.js';

const TILE = 'https://tiles.example.com/imagery/google-satellite/15/29105/12903.webp';
const DAY = 24 * 60 * 60 * 1000;

// https://fetch.spec.whatwg.org/#cors-safelisted-request-header
const SAFELISTED_HEADERS = new Set(['accept', 'accept-language', 'content-language', 'content-type']);
const SAFELISTED_CONTENT_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']);

type PageApi = typeof import('./index.js');

async function loadPage(): Promise<PageApi> {
  vi.resetModules();
  return import('./index.js');
}

function visualizerConfig(tokenConfig: { queryParameter?: string } = {}, onTokenExpired?: () => Promise<void>) {
  return {
    proxyUrl: 'https://tiles.example.com',
    protectedDomains: ['tiles.example.com'],
    namespace: 'reearth-visualizer',
    assetPatterns: { rasterTiles: /\/(?:cesium-mesh|imagery|google3d|v1\/3dtiles)\// },
    tokenConfig: { refreshThreshold: 60_000, ...tokenConfig },
    onTokenExpired,
  };
}

function headersThatWouldPreflight(request: Request): string[] {
  const offending: string[] = [];
  request.headers.forEach((value, name) => {
    if (!SAFELISTED_HEADERS.has(name)) offending.push(name);
    else if (name === 'content-type' && !SAFELISTED_CONTENT_TYPES.has(value.split(';')[0].trim().toLowerCase())) {
      offending.push(name);
    }
  });
  return offending;
}

describe('tokenConfig.queryParameter', () => {
  let rt: FakeServiceWorkerRuntime;

  beforeEach(() => {
    rt = new FakeServiceWorkerRuntime();
    rt.installPageGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the token in the query string as a CORS simple request, before and after a worker restart', async () => {
    const page = await loadPage();
    expect((await page.registerAssetSecurity(visualizerConfig({ queryParameter: 'token' }))).success).toBe(true);
    await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });

    for (const restart of [false, true]) {
      if (restart) await rt.restart();
      const resp = await rt.fetch(TILE);
      const upstream = rt.upstream[rt.upstream.length - 1];

      expect(resp.status).toBe(200);
      expect(rt.lastUpstreamURL()?.searchParams.getAll('token')).toEqual([rt.validToken]);
      expect(rt.lastUpstreamAuth()).toBeNull();
      expect(upstream.method).toBe('GET');
      expect(headersThatWouldPreflight(upstream)).toEqual([]);
    }
  });

  it('uses the configured parameter name', async () => {
    rt.queryTokenParam = 'access_token';
    const page = await loadPage();
    await page.registerAssetSecurity(visualizerConfig({ queryParameter: 'access_token' }));
    await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });

    expect((await rt.fetch(TILE)).status).toBe(200);
    expect(rt.lastUpstreamURL()?.searchParams.get('access_token')).toBe(rt.validToken);
    expect(rt.lastUpstreamURL()?.searchParams.has('token')).toBe(false);
  });

  it('replaces a parameter of the same name already in the URL and keeps the others', async () => {
    const page = await loadPage();
    await page.registerAssetSecurity(visualizerConfig({ queryParameter: 'token' }));
    await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });

    const resp = await rt.fetch(`${TILE}?token=tok-from-page&v=2`);

    expect(resp.status).toBe(200);
    expect(rt.lastUpstreamURL()?.searchParams.getAll('token')).toEqual([rt.validToken]);
    expect(rt.lastUpstreamURL()?.searchParams.get('v')).toBe('2');
  });

  it('retries a rejected token with the renewed one in the query string', async () => {
    const page = await loadPage();
    const onTokenExpired = vi.fn(async () => {
      await page.updateToken({ accessToken: 'tok-rotated', expiresAt: Date.now() + DAY });
    });
    await page.registerAssetSecurity(visualizerConfig({ queryParameter: 'token' }, onTokenExpired));
    await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });
    rt.validToken = 'tok-rotated';

    const resp = await rt.fetch(TILE);

    expect(onTokenExpired).toHaveBeenCalledTimes(1);
    expect(resp.status).toBe(200);
    expect(rt.lastUpstreamURL()?.searchParams.getAll('token')).toEqual(['tok-rotated']);
    expect(rt.lastUpstreamAuth()).toBeNull();
  });

  it('without the option, sends the Authorization header and leaves the URL alone', async () => {
    const page = await loadPage();
    await page.registerAssetSecurity(visualizerConfig());
    await page.updateToken({ accessToken: rt.validToken, expiresAt: Date.now() + DAY });

    expect((await rt.fetch(TILE)).status).toBe(200);
    expect(rt.lastUpstreamAuth()).toBe(`Bearer ${rt.validToken}`);
    expect(rt.lastUpstreamURL()?.href).toBe(TILE);
  });
});
