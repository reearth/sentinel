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
 * Answers the worker's token requests. Concurrent requests share one
 * onTokenExpired call, so a tile burst does not stampede the consumer's auth
 * endpoint. Never rejects.
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
    renewal ??= Promise.resolve()
      .then(onTokenExpired)
      .catch(() => {})
      .finally(() => {
        renewal = null;
      });
    return renewal;
  };

  return async (request) => {
    const replyType = request.type === 'REFRESH_TOKEN' ? 'TOKEN_REFRESHED' : 'TOKEN_PROVIDED';
    let token = fresh();
    if (!token) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        renew(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, deadlineMs);
        }),
      ]);
      clearTimeout(timer);
      token = fresh();
    }
    return token ? { type: replyType, token } : { type: 'TOKEN_UNAVAILABLE' };
  };
}
