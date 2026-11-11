## v0.2.0

**Who is affected: every app that uses Sentinel.** Upgrade and call
`registerAssetSecurity()` as before. The host must serve the service worker
script when its URL carries a query string, as static hosts do by default.

Browsers stop an idle service worker after about 30 s. The worker kept its
configuration only in memory, so after a restart it intercepted nothing, and
protected requests went out without `Authorization`. Map tiles came back 401
and stayed blurry until a reload. The configuration now travels in the service
worker's script URL (`/sw.js?sentinel=…`), which the browser restores on every
start. Existing `/sw.js` registrations move to the new URL on the next
`registerAssetSecurity()` call. A changed configuration installs a new worker.

The page now answers the worker's token requests, from the latest
`updateToken()` token or by awaiting `onTokenExpired`. Before, each miss
stalled for 5 s and then went out unauthenticated. When the server rejects a
token, the page is asked for a different one, and every open tab is asked, so
a tab on an older library no longer blocks the others.

The token is now attached only to protected domains and their subdomains. A
substring match had also sent it to hosts such as
`tiles.example.com.attacker.net`.

`extractAssetId` and `tokenConfig.memoryCacheTTL` are deprecated and ignored.
Passing `extractAssetId` used to make registration fail.

## v0.1.3

**Who is affected: apps that load many protected tiles at once, and apps that
cache responses whose origin sets `Cache-Control`.** No configuration or API
changes.

When no token was stored, each intercepted request asked the page for one on
its own and waited up to 5 s. A map or globe that fires hundreds of tile
requests while panning turned a missing or late token into hundreds of
parallel messages and stalled requests. All concurrent requests now share one
acquisition. If the page does not answer, further requests fail fast for 15 s
instead of each waiting out the timeout.

Cached responses now follow the origin's `Cache-Control`. A `no-store`
response is never stored. Cache-first serves a stored copy only while it is
within its own `max-age`, falling back to `cache.maxAge` when the origin sets
none, and refetches once it is stale, serving the stale copy only if the
network fails. Cache-first no longer refetches in the background on every hit,
which had doubled upstream traffic for cached tiles.

The build moved to TypeScript 7 and Vite 8. The published files and type
declarations are identical to 0.1.2.

## v0.1.2

Page-side logging now goes through the debug helpers, so
`registerAssetSecurity` is silent unless `debug` is set.

## v0.1.1

The service worker now controls the page before any protected request is sent,
so the first requests after registration carry the token. The worker logs to
the console only when `debug` is set.

## v0.1.0

First release.
