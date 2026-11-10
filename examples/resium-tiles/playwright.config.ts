import { defineConfig, devices } from '@playwright/test';

// Endform note: its runners must reach BOTH the app and the tile server, so
// localhost will not work there. Point BASE_URL and TILE_ORIGIN at public URLs
// (for example a tunnel or a preview deploy) and set SKIP_WEBSERVER=1.
// Endform caps a test at 4 minutes and does not support .only().
const baseURL = process.env.BASE_URL ?? 'http://localhost:5173';
const tileOrigin = process.env.TILE_ORIGIN ?? 'http://localhost:8788';
const token = process.env.TOKEN ?? 'test-token';
const tilePort = new URL(tileOrigin).port || '8788';

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.SKIP_WEBSERVER
    ? undefined
    : [
        {
          command: 'node server/tile-server.mjs',
          url: `${tileOrigin}/stats`,
          env: { TOKEN: token, PORT: tilePort },
          reuseExistingServer: !process.env.CI,
        },
        {
          command: 'npx vite --port 5173 --strictPort',
          url: baseURL,
          env: { TOKEN: token, VITE_TILE_ORIGIN: tileOrigin },
          reuseExistingServer: !process.env.CI,
        },
      ],
});
