import type { Token } from './types.js';

export type TokenRequest =
  | { type: 'REQUEST_TOKEN' }
  | { type: 'REFRESH_TOKEN'; refreshToken?: string };

export type TokenReply =
  | { type: 'TOKEN_PROVIDED' | 'TOKEN_REFRESHED'; token: Token }
  | { type: 'TOKEN_UNAVAILABLE' };

export interface TokenSource {
  latest(): Token | null;
  onTokenExpired?: () => void | Promise<void>;
  refreshThreshold: number;
  now(): number;
  reportError?(error: unknown): void;
}

/** Shorter than the worker's 5s wait, so the worker hears "no" before it gives up on its own. */
export const TOKEN_REPLY_DEADLINE_MS = 3000;

let current: Token | null = null;

export function rememberToken(token: Token): void {
  current = token;
}

export function latestToken(): Token | null {
  return current;
}

export function forgetToken(): void {
  current = null;
}

/**
 * Answers the worker's token requests. REQUEST_TOKEN takes the latest fresh
 * token; REFRESH_TOKEN means the server rejected the worker's token, so it
 * always renews and never hands back the token the page had before.
 * Concurrent requests share one onTokenExpired call, so a tile burst does not
 * stampede the consumer's auth endpoint. Never rejects.
 */
export function createTokenResponder(
  source: TokenSource,
  deadlineMs = TOKEN_REPLY_DEADLINE_MS
): (request: TokenRequest) => Promise<TokenReply> {
  let renewal: Promise<void> | null = null;

  const fresh = (): Token | null => {
    const token = source.latest();
    return token && token.expires_at - source.now() > source.refreshThreshold ? token : null;
  };

  const renew = (): Promise<void> => {
    const onTokenExpired = source.onTokenExpired;
    if (!onTokenExpired) return Promise.resolve();
    if (!renewal) {
      const current: Promise<void> = Promise.resolve()
        .then(onTokenExpired)
        .catch((error: unknown) => source.reportError?.(error))
        .finally(() => {
          if (renewal === current) renewal = null;
        });
      renewal = current;
    }
    return renewal;
  };

  return async (request) => {
    const refreshing = request.type === 'REFRESH_TOKEN';
    const before = source.latest();
    let token = refreshing ? null : fresh();
    if (!token) {
      const pending = renew();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        pending.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), deadlineMs);
        }),
      ]);
      clearTimeout(timer);
      // A hung onTokenExpired must not hold every later request hostage.
      if (timedOut && renewal === pending) renewal = null;
      token = fresh();
      if (refreshing && token?.access_token === before?.access_token) token = null;
    }
    if (!token) return { type: 'TOKEN_UNAVAILABLE' };
    return { type: refreshing ? 'TOKEN_REFRESHED' : 'TOKEN_PROVIDED', token };
  };
}
