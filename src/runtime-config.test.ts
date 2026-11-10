import { describe, expect, it } from 'vitest';
import {
  CONFIG_PARAM,
  decodeRuntimeConfig,
  encodeRuntimeConfig,
  serviceWorkerScriptUrl,
  toRuntimeConfig,
} from './runtime-config.js';

const visualizer = {
  proxyUrl: 'https://tiles.example.com',
  protectedDomains: ['tiles.example.com', 'localhost:8080'],
  namespace: 'reearth-visualizer',
  assetPatterns: { rasterTiles: /\/(?:cesium-mesh|imagery|google3d|v1\/3dtiles)\// },
  tokenConfig: { memoryCacheTTL: 300_000, refreshThreshold: 45_000 },
  cacheStrategies: { tiles: 'cache-first' as const },
  debug: true,
};

function searchOf(scriptUrl: string): string {
  return new URL(scriptUrl, 'https://app.example.com').search;
}

describe('runtime config in the service worker script URL', () => {
  it("round-trips reearth-visualizer's config through the script URL", () => {
    const runtime = toRuntimeConfig(visualizer);
    const decoded = decodeRuntimeConfig(searchOf(serviceWorkerScriptUrl('/sw.js', runtime)));

    expect(decoded).toEqual(runtime);
    expect(decoded).toMatchObject({
      namespace: 'reearth-visualizer',
      protectedDomains: ['localhost:8080', 'tiles.example.com'],
      proxyEndpoint: 'https://tiles.example.com',
      token: { refreshThreshold: 45_000 },
      cacheStrategies: { tiles: 'cache-first' },
      debug: true,
    });
  });

  it('preserves RegExp source and flags, including URL-unsafe characters', () => {
    const patterns = {
      customAssets: /\/(?:a|b)\//i,
      mvtTiles: /\.mvt\?v=\d+&x=#\+/gu,
      generalAssets: /^\/assets\/ü\//m,
    };
    const runtime = toRuntimeConfig({ ...visualizer, assetPatterns: patterns });
    const decoded = decodeRuntimeConfig(searchOf(serviceWorkerScriptUrl('/sw.js', runtime)));

    for (const [key, pattern] of Object.entries(patterns)) {
      const restored = decoded?.assetPatterns[key as keyof typeof patterns];
      expect(restored?.source).toBe(pattern.source);
      expect(restored?.flags).toBe(pattern.flags);
    }
  });

  it('encodes equal configs to the same string regardless of key order', () => {
    const reordered = {
      debug: true,
      cacheStrategies: { tiles: 'cache-first' as const },
      tokenConfig: { refreshThreshold: 45_000, memoryCacheTTL: 300_000 },
      assetPatterns: { rasterTiles: /\/(?:cesium-mesh|imagery|google3d|v1\/3dtiles)\// },
      namespace: 'reearth-visualizer',
      protectedDomains: ['tiles.example.com', 'localhost:8080'],
      proxyUrl: 'https://tiles.example.com',
    };

    expect(encodeRuntimeConfig(toRuntimeConfig(reordered))).toBe(
      encodeRuntimeConfig(toRuntimeConfig(visualizer))
    );
  });

  it('encodes equal domain sets to the same string regardless of order or repeats', () => {
    expect(
      encodeRuntimeConfig(toRuntimeConfig({ ...visualizer, protectedDomains: ['tiles.example.com', 'localhost:8080', 'tiles.example.com'] }))
    ).toBe(encodeRuntimeConfig(toRuntimeConfig({ ...visualizer, protectedDomains: ['localhost:8080', 'tiles.example.com'] })));
  });

  it('memoryCacheTTL does not reach the worker, so changing it does not reinstall', () => {
    const withTtl = (memoryCacheTTL: number) =>
      encodeRuntimeConfig(toRuntimeConfig({ ...visualizer, tokenConfig: { memoryCacheTTL, refreshThreshold: 45_000 } }));

    expect(withTtl(1)).toBe(withTtl(300_000));
  });

  it.each([
    ['no query', ''],
    ['a foreign query only', '?build=42'],
    ['an empty param', `?${CONFIG_PARAM}=`],
    ['bad base64', `?${CONFIG_PARAM}=%%%`],
    ['bad JSON', `?${CONFIG_PARAM}=${btoa('{nope')}`],
    ['an unknown version', `?${CONFIG_PARAM}=${btoa(JSON.stringify({ v: 2, ns: 'a', d: [], p: {}, x: '' }))}`],
    ['an invalid regex source', `?${CONFIG_PARAM}=${btoa(JSON.stringify({ v: 1, ns: 'a', d: [], p: { mvtTiles: ['(', ''] }, x: '' }))}`],
    ['an invalid regex flag', `?${CONFIG_PARAM}=${btoa(JSON.stringify({ v: 1, ns: 'a', d: [], p: { mvtTiles: ['a', 'zz'] }, x: '' }))}`],
    ['a non-string domain', `?${CONFIG_PARAM}=${btoa(JSON.stringify({ v: 1, ns: 'a', d: [1], p: {}, x: '' }))}`],
    ['a missing namespace', `?${CONFIG_PARAM}=${btoa(JSON.stringify({ v: 1, d: [], p: {}, x: '' }))}`],
    ['a missing proxy endpoint', `?${CONFIG_PARAM}=${btoa(JSON.stringify({ v: 1, ns: 'a', d: [], p: {} }))}`],
    ['a JSON array', `?${CONFIG_PARAM}=${btoa('[]')}`],
  ])('decodes %s to null without throwing', (_label, search) => {
    expect(decodeRuntimeConfig(search)).toBeNull();
  });

  it('drops an invalid optional field and keeps the rest of the config', () => {
    const wire = {
      v: 1,
      ns: 'reearth-visualizer',
      d: ['tiles.example.com'],
      p: {},
      x: 'https://tiles.example.com',
      t: { rt: 'soon' },
      c: { tiles: 'yolo', images: 'cache-first' },
    };

    expect(decodeRuntimeConfig(`?${CONFIG_PARAM}=${btoa(JSON.stringify(wire))}`)).toEqual({
      namespace: 'reearth-visualizer',
      protectedDomains: ['tiles.example.com'],
      assetPatterns: {},
      proxyEndpoint: 'https://tiles.example.com',
      token: {},
      cacheStrategies: { images: 'cache-first' },
      debug: false,
    });
  });

  it.each([NaN, Infinity, -Infinity])('rejects a refreshThreshold of %s', (refreshThreshold) => {
    expect(() => toRuntimeConfig({ ...visualizer, tokenConfig: { refreshThreshold } })).toThrow(/refreshThreshold/);
  });

  it('keeps other query params on serviceWorkerPath', () => {
    const url = serviceWorkerScriptUrl('/static/sw.js?build=42', toRuntimeConfig(visualizer));
    const parsed = new URL(url, 'https://app.example.com');

    expect(parsed.pathname).toBe('/static/sw.js');
    expect(parsed.searchParams.get('build')).toBe('42');
    expect(decodeRuntimeConfig(parsed.search)?.namespace).toBe('reearth-visualizer');
  });
});
