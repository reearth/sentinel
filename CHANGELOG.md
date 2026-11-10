# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-11-10

### Fixed

- **Protected requests stay authenticated after the browser stops an idle
  service worker.** The worker kept its configuration only in memory, so
  after a restart it intercepted nothing and looked for the token under the
  default namespace, and tiles went out without `Authorization`. The
  configuration now travels in the service worker's script URL, which the
  browser restores on every start. Existing `/sw.js` registrations move to
  the new URL on the next `registerAssetSecurity()` call.
- **`onTokenExpired` is called when the service worker needs a token.** The
  page never answered the worker's token requests, so each miss stalled for
  5 s and then went out unauthenticated. The page now answers from the
  latest `updateToken()` token or by awaiting `onTokenExpired` (one call for
  concurrent requests, at most 3 s).
- Token requests from a page that reused an existing registration are
  answered too; the message listener was only installed on a first-time
  registration.
- Concurrent requests after a worker restart no longer fail to read the
  stored token while the token database is still opening.
- `registerAssetSecurity()` waits for the newly installed worker instead of
  resolving while the previous one is still active.
- `tokenConfig` and `cacheStrategies` now reach the service worker; they
  were silently dropped before.
- **The token is attached only to protected domains and their
  subdomains.** Matching used a substring test, so `tiles.example.com`
  also matched `tiles.example.com.attacker.net` and the bearer token was
  sent there.
- **A token the server rejects is renewed.** On a 401 or 403 the page
  answered with the same unexpired token, so tiles stayed 401. The worker
  now asks for a different token, and the page always calls
  `onTokenExpired` for it.
- The worker asks every open tab for a token. A tab on an older library,
  which never answers, no longer makes every request wait 5 s.
- A worker installed at a bare `/sw.js`, for example by the browser's
  update check in a tab on an older library, takes its configuration from
  that tab's `CONFIG` message instead of intercepting nothing.
- Activation deletes only earlier cache versions of its own namespace,
  not every other cache on the origin.
- `registerAssetSecurity()` fails instead of reporting success when the
  new worker fails to install or does not activate within
  `serviceWorkerControlTimeout`, or when the configuration cannot reach
  the worker, such as a non-finite `refreshThreshold`.
- A hung `onTokenExpired` no longer blocks later token requests after
  the 3 s deadline, and a failing one is logged in debug mode.
- The token database is reopened after the browser closes it, and no
  longer blocks a newer version from opening.
- An unreadable `sentinel` config in the script URL logs a warning even
  without `debug`.

### Deprecated

- `extractAssetId` is ignored. Passing a function made registration fail
  with a `DataCloneError`.
- `tokenConfig.memoryCacheTTL` is ignored. The worker never read it; it
  no longer reaches the worker, so changing it does not reinstall it.

## [0.1.3] — 2026-11-06

### Fixed

- **Concurrent requests share one token acquisition.** With no stored token,
  every intercepted request used to send its own `REQUEST_TOKEN` to the page
  and wait up to 5 s, so a renderer's tile burst became hundreds of parallel
  messages. Requests now wait on one in-flight acquisition, and an unanswered
  request opens a 15 s backoff window in which further requests fail fast.
- **Cache strategies honor the upstream `Cache-Control`.** `no-store`
  responses are no longer cached. Each stored response is stamped with its
  storage time, and cache-first serves it only within its `max-age` (falling
  back to `cache.maxAge`), then refetches, serving the stale copy if the
  network fails. The background refetch on every cache hit is gone.

### Changed

- The package is built with TypeScript 7 and Vite 8. The published files and
  type declarations are unchanged, and `dist/sw.js` is about 9% smaller
  gzipped.

## [0.1.2] — 2026-06-16

### Fixed

- Page-side logging goes through the debug helpers, so `registerAssetSecurity`
  logs nothing unless `debug` is set.

## [0.1.1] — 2026-06-04

### Fixed

- The service worker controls the page before protected requests are sent
  (#5).

### Changed

- The service worker logs to the console only when `debug` is set (#4).

## [0.1.0] — 2026-06-04

### Added

- First release: a service worker that attaches a bearer token to asset and
  tile requests for configured domains, with token handshake, refresh and
  caching strategies.
