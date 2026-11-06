# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
