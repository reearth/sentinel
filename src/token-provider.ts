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

export const WORKER_TOKEN_WAIT_MS = 5000;

const REPLY_TRANSIT_MARGIN_MS = 2000;

export const TOKEN_REPLY_DEADLINE_MS = WORKER_TOKEN_WAIT_MS - REPLY_TRANSIT_MARGIN_MS;

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
      if (timedOut && renewal === pending) renewal = null;
      token = fresh();
      if (refreshing && token?.access_token === before?.access_token) token = null;
    }
    if (!token) return { type: 'TOKEN_UNAVAILABLE' };
    return { type: refreshing ? 'TOKEN_REFRESHED' : 'TOKEN_PROVIDED', token };
  };
}
