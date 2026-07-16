import { describe, expect, it } from 'vitest';
import {
  CACHED_AT_HEADER,
  isCacheable,
  isFresh,
  withCacheStamp,
} from './cache-policy.js';

const MINUTE = 60_000;

function response(headers: Record<string, string> = {}, status = 200): Response {
  return new Response('tile-bytes', { status, headers });
}

describe('isCacheable', () => {
  it('allows ordinary OK responses', () => {
    expect(isCacheable(response())).toBe(true);
  });

  it('allows private responses — the SW cache is the single user\'s own cache', () => {
    expect(isCacheable(response({ 'cache-control': 'private, max-age=14400' }))).toBe(true);
  });

  it('refuses no-store responses', () => {
    expect(isCacheable(response({ 'cache-control': 'no-store' }))).toBe(false);
  });

  it('refuses non-OK responses', () => {
    expect(isCacheable(response({}, 404))).toBe(false);
  });
});

describe('withCacheStamp / isFresh', () => {
  it('unstamped responses are never fresh', () => {
    expect(isFresh(response({ 'cache-control': 'max-age=3600' }), 3600)).toBe(false);
  });

  it('honors the response max-age: fresh before it lapses, stale after', () => {
    const now = 1_000_000_000_000;
    const stamped = withCacheStamp(response({ 'cache-control': 'private, max-age=14400' }), now);
    expect(stamped.headers.get(CACHED_AT_HEADER)).toBe(String(now));
    expect(isFresh(stamped, 3600, now + 60 * MINUTE)).toBe(true);
    expect(isFresh(stamped, 3600, now + 300 * MINUTE)).toBe(false);
  });

  it('max-age=0 is immediately stale', () => {
    const now = 1_000_000_000_000;
    const stamped = withCacheStamp(response({ 'cache-control': 'max-age=0' }), now);
    expect(isFresh(stamped, 3600, now + 1)).toBe(false);
  });

  it('falls back to the configured default when the response has no max-age', () => {
    const now = 1_000_000_000_000;
    const stamped = withCacheStamp(response(), now);
    expect(isFresh(stamped, 3600, now + 30 * MINUTE)).toBe(true);
    expect(isFresh(stamped, 3600, now + 61 * MINUTE)).toBe(false);
  });
});
