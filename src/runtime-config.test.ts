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
      protectedDomains: ['tiles.example.com', 'localhost:8080'],
      proxyEndpoint: 'https://tiles.example.com',
      token: { memoryCacheTTL: 300_000, refreshThreshold: 45_000 },
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
    ['an unknown cache strategy', `?${CONFIG_PARAM}=${btoa(JSON.stringify({ v: 1, ns: 'a', d: [], p: {}, x: '', c: { tiles: 'yolo' } }))}`],
    ['a JSON array', `?${CONFIG_PARAM}=${btoa('[]')}`],
  ])('decodes %s to null without throwing', (_label, search) => {
    expect(decodeRuntimeConfig(search)).toBeNull();
  });

  it('keeps other query params on serviceWorkerPath', () => {
    const url = serviceWorkerScriptUrl('/static/sw.js?build=42', toRuntimeConfig(visualizer));
    const parsed = new URL(url, 'https://app.example.com');

    expect(parsed.pathname).toBe('/static/sw.js');
    expect(parsed.searchParams.get('build')).toBe('42');
    expect(decodeRuntimeConfig(parsed.search)?.namespace).toBe('reearth-visualizer');
  });
});
