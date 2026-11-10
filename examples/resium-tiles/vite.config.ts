import { createReadStream, existsSync, statSync } from 'node:fs';
import { cp, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const swSource = resolve(here, '../../dist/sw.js');
const cesiumBuild = resolve(here, 'node_modules/cesium/Build/Cesium');
const CESIUM_DIRS = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];
const TOKEN = process.env.TOKEN ?? 'test-token';
const TTL_MS = Number(process.env.TOKEN_TTL_MS ?? 3_600_000);

const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml',
  '.map': 'application/json',
};

function staticAssets(): Plugin {
  return {
    name: 'sentinel-example-static',
    configureServer(server) {
      if (!existsSync(swSource)) {
        server.config.logger.error(
          `Missing ${swSource}. Run "npm run build" at the repo root first.`,
        );
      }
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        if (path === '/config.json') {
          res.setHeader('content-type', 'application/json');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify({ token: TOKEN, ttlMs: TTL_MS }));
          return;
        }
        let file: string | null = null;
        if (path === '/sw.js') file = swSource;
        else if (path === '/sw.js.map') file = `${swSource}.map`;
        else if (path.startsWith('/cesium/')) file = join(cesiumBuild, path.slice('/cesium/'.length));
        if (!file || (path.startsWith('/cesium/') && !file.startsWith(cesiumBuild))) return next();
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
        res.setHeader('cache-control', 'no-store');
        createReadStream(file).pipe(res);
      });
    },
    async closeBundle() {
      const out = resolve(here, 'dist');
      await mkdir(out, { recursive: true });
      await copyFile(swSource, join(out, 'sw.js'));
      await Promise.all(
        CESIUM_DIRS.map((d) => cp(join(cesiumBuild, d), join(out, 'cesium', d), { recursive: true })),
      );
      await writeFile(join(out, 'config.json'), JSON.stringify({ token: TOKEN, ttlMs: TTL_MS }));
    },
  };
}

export default defineConfig({
  plugins: [react(), staticAssets()],
  define: { CESIUM_BASE_URL: JSON.stringify('/cesium') },
  server: { port: 5173, strictPort: true },
});
