# Sentinel + Resium tiles example

Reproduces and verifies the "blurry Google satellite imagery" bug end to end.

Background: Sentinel's service worker (SW) adds `Authorization: Bearer` to tile requests for protected domains. Browsers stop idle service workers after about 30 seconds. Before the fix, a restarted SW had forgotten its config and token, so tiles went out unauthenticated, got 401, and Cesium kept the low-zoom parent imagery (blurry). After the fix, the config lives in the SW script URL and the SW asks the page for a token on restart.

The example mirrors the reearth-visualizer client config: a Resium viewer with a `UrlTemplateImageryProvider` pointing at a local tile server on another origin that returns 401 unless the Bearer token matches. No Cesium Ion is used.

| Piece | Where | Port |
| --- | --- | --- |
| Vite + React + Resium app | `src/`, `vite.config.ts` | 5173 |
| Tile server (401 without token, counts requests) | `server/tile-server.mjs` | 8788 |

The app serves `/sw.js` from `../../dist/sw.js` and `/config.json` (`{token, ttlMs}`).

## Run

```bash
# 1. Build the library at the repo root (produces dist/index.js and dist/sw.js).
cd ../.. && npm install && npm run build

# 2. Install and start the example.
cd examples/resium-tiles
npm install
npm run dev          # tile server + app; open http://localhost:5173
```

Environment: `TOKEN` (default `test-token`), `TOKEN_TTL_MS` (default one hour), `VITE_TILE_ORIGIN` (default `http://localhost:8788`), `PORT` for the tile server.

Tile server endpoints: `GET /imagery/test/{z}/{x}/{y}.png`, `GET /stats` (`{ok, unauthorized, byZoom}`), `POST /stats/reset`.

The HUD (top left) shows SW state, the tile server's ok and 401 counts per zoom, and how many times `onTokenExpired` ran. Tiles show their `z/x/y` and a colour per zoom level. A blurry tile has a low zoom number stretched across the screen.

## Manual repro

1. Open http://localhost:5173, wait for tiles, click "Reset stats".
2. Stop the SW: `chrome://serviceworker-internals` and click Stop on the localhost:5173 worker, or DevTools > Application > Service Workers > Stop. (The "Simulate idle SW stop" button only explains this; a page cannot stop its own worker.)
3. Pan or zoom the globe to places you have not seen.
4. Watch the HUD.

Old library (bug): the 401 count climbs and new areas stay at a low zoom number and look blurry.
Fixed library: 401 stays at 0 and tiles sharpen to the requested zoom.

"Expire token" calls `updateToken` with an `expiresAt` in the past. Repeat steps 2 and 3 afterwards: `onTokenExpired` should run (HUD counter goes up) and 401 stays at 0.

### Switching library versions

The example links the repo root via `file:../..` and serves `../../dist/sw.js`, so rebuild the root after switching:

```bash
cd ../..
git stash -u            # if you have local changes
git checkout v0.1.3     # or origin/main for the old behaviour
npm install && npm run build
cd examples/resium-tiles && npm run dev
```

The `examples/` directory is untracked on old checkouts; keep a copy outside the tree or use `git worktree add ../sentinel-old v0.1.3`, build there, and point the dependency at it (`npm install ../sentinel-old` in the example, plus the `swSource` path in `vite.config.ts`). Then switch back to the fix branch and rebuild. Unregister the SW between runs (DevTools > Application > Storage > Clear site data) so you test a fresh install.

## Playwright tests

`tests/no-blurry-tiles.spec.ts` covers three cases, each asserting `/stats` shows `unauthorized === 0` and `ok > 0` after the SW is stopped via CDP and the camera moves to new places:

1. SW stopped, then tiles requested.
2. Token expired first, then SW stopped (exercises `onTokenExpired`).
3. SW stopped, page reloaded, SW stopped again.

Run locally (Chromium only; the config starts both servers):

```bash
npx playwright install chromium
npx playwright test
```

Run on Endform:

```bash
npx endform@latest test
```

Endform needs `ENDFORM_API_KEY`. Its runners cannot see `localhost`, so the app and the tile server must both be publicly reachable (a tunnel or a deploy). Set `BASE_URL`, `TILE_ORIGIN`, and `SKIP_WEBSERVER=1`; `TILE_ORIGIN` must also be the `VITE_TILE_ORIGIN` the deployed app was built with, and the app's `TOKEN` must match the tile server's. See Endform's local-network proxying guide if you want to keep servers on localhost. Endform caps a test at 4 minutes (these use well under) and does not support `.only()`.

Against the old library, all three tests should fail on `unauthorized`. Against the fix they should pass.
