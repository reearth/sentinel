import type { AssetSecurityConfig } from './public-types.js';
import type { CacheStrategy } from './types.js';

/**
 * What the service worker needs to know, already parsed. It travels in the
 * worker's script URL: the browser persists that URL with the registration
 * and restores it on every worker start, so the config survives the browser
 * terminating an idle worker, and a config change is an ordinary SW update.
 */
export interface RuntimeConfig {
  readonly namespace: Namespace;
  readonly protectedDomains: readonly string[];
  readonly assetPatterns: Partial<Readonly<Record<AssetPatternKey, RegExp>>>;
  readonly proxyEndpoint: string;
  readonly token: { readonly refreshThreshold?: number };
  readonly cacheStrategies: Partial<Readonly<Record<CacheAssetKind, CacheStrategy>>>;
  readonly debug: boolean;
}

export type Namespace = string & { readonly __brand: 'Namespace' };
export type AssetPatternKey = 'customAssets' | 'mvtTiles' | 'rasterTiles' | 'generalAssets';
type CacheAssetKind = 'images' | 'tiles' | 'documents';

export const CONFIG_PARAM = 'sentinel';

const PATTERN_KEYS: readonly AssetPatternKey[] = ['customAssets', 'mvtTiles', 'rasterTiles', 'generalAssets'];
const CACHE_KINDS: readonly CacheAssetKind[] = ['images', 'tiles', 'documents'];
const CACHE_STRATEGIES: readonly CacheStrategy[] = ['cache-first', 'network-first', 'network-only', 'cache-only'];

interface WireV1 {
  v: 1;
  ns: string;
  d: string[];
  p: Partial<Record<AssetPatternKey, [source: string, flags: string]>>;
  x: string;
  t?: { rt?: number };
  c?: Partial<Record<CacheAssetKind, CacheStrategy>>;
  dbg?: 1;
}

export function toRuntimeConfig(
  config: AssetSecurityConfig & { namespace: string; debug: boolean }
): RuntimeConfig {
  const assetPatterns: Partial<Record<AssetPatternKey, RegExp>> = {};
  for (const key of PATTERN_KEYS) {
    const pattern = config.assetPatterns?.[key];
    if (pattern) assetPatterns[key] = pattern;
  }

  const token: { refreshThreshold?: number } = {};
  const refreshThreshold = config.tokenConfig?.refreshThreshold;
  if (refreshThreshold !== undefined) {
    if (!Number.isFinite(refreshThreshold)) {
      throw new Error(`tokenConfig.refreshThreshold must be a finite number, got ${refreshThreshold}`);
    }
    token.refreshThreshold = refreshThreshold;
  }

  const cacheStrategies: Partial<Record<CacheAssetKind, CacheStrategy>> = {};
  for (const kind of CACHE_KINDS) {
    const strategy = config.cacheStrategies?.[kind];
    if (strategy) cacheStrategies[kind] = strategy;
  }

  return {
    namespace: config.namespace as Namespace,
    protectedDomains: canonicalDomains(config.protectedDomains),
    assetPatterns,
    proxyEndpoint: config.proxyUrl,
    token,
    cacheStrategies,
    debug: config.debug,
  };
}

/** Equal configs encode to the same string, so re-registering does not reinstall the worker. */
export function encodeRuntimeConfig(config: RuntimeConfig): string {
  const wire: WireV1 = { v: 1, ns: config.namespace, d: canonicalDomains(config.protectedDomains), p: {}, x: config.proxyEndpoint };
  for (const key of PATTERN_KEYS) {
    const pattern = config.assetPatterns[key];
    if (pattern) wire.p[key] = [pattern.source, pattern.flags];
  }
  if (config.token.refreshThreshold !== undefined) wire.t = { rt: config.token.refreshThreshold };
  const cache: Partial<Record<CacheAssetKind, CacheStrategy>> = {};
  for (const kind of CACHE_KINDS) {
    const strategy = config.cacheStrategies[kind];
    if (strategy) cache[kind] = strategy;
  }
  if (Object.keys(cache).length > 0) wire.c = cache;
  if (config.debug) wire.dbg = 1;
  return toBase64Url(JSON.stringify(wire));
}

export function serviceWorkerScriptUrl(serviceWorkerPath: string, config: RuntimeConfig): string {
  const queryStart = serviceWorkerPath.indexOf('?');
  const path = queryStart < 0 ? serviceWorkerPath : serviceWorkerPath.slice(0, queryStart);
  const params = new URLSearchParams(queryStart < 0 ? '' : serviceWorkerPath.slice(queryStart + 1));
  params.set(CONFIG_PARAM, encodeRuntimeConfig(config));
  return `${path}?${params}`;
}

/**
 * Never throws: it runs during worker script evaluation, where a throw would
 * leave every fetch on the origin without a worker. Anything unreadable,
 * including a legacy bare `/sw.js`, is null.
 */
export function decodeRuntimeConfig(search: string): RuntimeConfig | null {
  try {
    const encoded = new URLSearchParams(search).get(CONFIG_PARAM);
    if (!encoded) return null;
    return parseWire(JSON.parse(fromBase64Url(encoded)));
  } catch {
    return null;
  }
}

function parseWire(wire: unknown): RuntimeConfig | null {
  if (!isRecord(wire) || wire.v !== 1) return null;
  const { ns, d, p, x, t, c, dbg } = wire;
  if (typeof ns !== 'string' || ns === '' || typeof x !== 'string') return null;
  if (!Array.isArray(d) || !d.every((domain) => typeof domain === 'string')) return null;
  if (!isRecord(p)) return null;

  const assetPatterns: Partial<Record<AssetPatternKey, RegExp>> = {};
  for (const key of PATTERN_KEYS) {
    const entry = p[key];
    if (entry === undefined) continue;
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') return null;
    assetPatterns[key] = new RegExp(entry[0], entry[1]);
  }

  // Optional fields have safe defaults, so an invalid one is dropped rather
  // than leaving the whole worker unconfigured.
  const token: { refreshThreshold?: number } = {};
  if (isRecord(t) && Number.isFinite(t.rt)) token.refreshThreshold = t.rt as number;

  const cacheStrategies: Partial<Record<CacheAssetKind, CacheStrategy>> = {};
  if (isRecord(c)) {
    for (const kind of CACHE_KINDS) {
      const strategy = c[kind];
      if (CACHE_STRATEGIES.includes(strategy as CacheStrategy)) cacheStrategies[kind] = strategy as CacheStrategy;
    }
  }

  return {
    namespace: ns as Namespace,
    protectedDomains: d,
    assetPatterns,
    proxyEndpoint: x,
    token,
    cacheStrategies,
    debug: dbg === 1,
  };
}

/** Sorted and deduplicated: the same set of domains always gives the same script URL. */
function canonicalDomains(domains: readonly string[]): string[] {
  return [...new Set(domains)].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBase64Url(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
}
