import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenResponder, TOKEN_REPLY_DEADLINE_MS, type TokenSource } from './token-provider.js';
import type { Token } from './types.js';

const NOW = 1_000_000;
const THRESHOLD = 60_000;

function token(accessToken: string, expiresIn: number): Token {
  return { access_token: accessToken, expires_at: NOW + expiresIn };
}

function source(initial: Token | null, onTokenExpired?: TokenSource['onTokenExpired']) {
  let latest = initial;
  return {
    set(next: Token) {
      latest = next;
    },
    source: {
      latest: () => latest,
      onTokenExpired,
      refreshThreshold: THRESHOLD,
      now: () => NOW,
    } satisfies TokenSource,
  };
}

describe('page token responder', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers REQUEST_TOKEN with the latest updateToken token without calling onTokenExpired', async () => {
    const onTokenExpired = vi.fn();
    const { source: src } = source(token('tok-fresh', THRESHOLD + 1), onTokenExpired);

    const reply = await createTokenResponder(src)({ type: 'REQUEST_TOKEN' });

    expect(reply).toEqual({ type: 'TOKEN_PROVIDED', token: token('tok-fresh', THRESHOLD + 1) });
    expect(onTokenExpired).not.toHaveBeenCalled();
  });

  it('calls onTokenExpired for a stale token and replies with the token it set', async () => {
    const state = source(token('tok-stale', THRESHOLD));
    const onTokenExpired = vi.fn(async () => state.set(token('tok-new', 3_600_000)));
    const respond = createTokenResponder({ ...state.source, onTokenExpired });

    const reply = await respond({ type: 'REQUEST_TOKEN' });

    expect(onTokenExpired).toHaveBeenCalledTimes(1);
    expect(reply).toEqual({ type: 'TOKEN_PROVIDED', token: token('tok-new', 3_600_000) });
  });

  it('shares one onTokenExpired call across concurrent requests', async () => {
    const state = source(null);
    let finish!: () => void;
    const onTokenExpired = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            state.set(token('tok-new', 3_600_000));
            resolve();
          };
        })
    );
    const respond = createTokenResponder({ ...state.source, onTokenExpired });

    const replies = Promise.all(Array.from({ length: 10 }, () => respond({ type: 'REQUEST_TOKEN' })));
    await Promise.resolve();
    finish();

    expect((await replies).every((r) => r.type === 'TOKEN_PROVIDED')).toBe(true);
    expect(onTokenExpired).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['throws', () => Promise.reject(new Error('auth down'))],
    ['sets no token', () => Promise.resolve()],
    ['is not configured', undefined],
  ])('replies TOKEN_UNAVAILABLE without waiting when onTokenExpired %s', async (_label, onTokenExpired) => {
    vi.useFakeTimers();
    const { source: src } = source(null, onTokenExpired);

    const reply = await createTokenResponder(src)({ type: 'REQUEST_TOKEN' });

    expect(reply).toEqual({ type: 'TOKEN_UNAVAILABLE' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replies TOKEN_UNAVAILABLE at the deadline when onTokenExpired hangs', async () => {
    vi.useFakeTimers();
    const { source: src } = source(null, () => new Promise<void>(() => {}));
    let reply: unknown;

    createTokenResponder(src)({ type: 'REQUEST_TOKEN' }).then((r) => (reply = r));
    await vi.advanceTimersByTimeAsync(TOKEN_REPLY_DEADLINE_MS - 1);
    expect(reply).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(reply).toEqual({ type: 'TOKEN_UNAVAILABLE' });
    expect(TOKEN_REPLY_DEADLINE_MS).toBeLessThan(5000);
  });

  it('answers REFRESH_TOKEN with TOKEN_REFRESHED', async () => {
    const { source: src } = source(token('tok-fresh', 3_600_000));

    const reply = await createTokenResponder(src)({ type: 'REFRESH_TOKEN', refreshToken: 'r' });

    expect(reply).toEqual({ type: 'TOKEN_REFRESHED', token: token('tok-fresh', 3_600_000) });
  });
});
