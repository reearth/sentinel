import { expect, test, type CDPSession, type Page } from '@playwright/test';

const TILE_ORIGIN = process.env.TILE_ORIGIN ?? 'http://localhost:8788';

interface Stats {
  ok: number;
  unauthorized: number;
  byZoom: Record<string, { ok: number; unauthorized: number }>;
}

const getStats = async (page: Page): Promise<Stats> =>
  (await page.request.get(`${TILE_ORIGIN}/stats`)).json();
const resetStats = async (page: Page) => {
  await page.request.post(`${TILE_ORIGIN}/stats/reset`);
};

async function loadApp(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__sentinelReady === true && !!window.__viewer, null, { timeout: 60_000 });
  await expect.poll(async () => (await getStats(page)).ok, { timeout: 60_000 }).toBeGreaterThan(0);
}

async function stopServiceWorker(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  const states: string[] = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (e) => {
    for (const v of e.versions) states.push(v.runningStatus);
  });
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect.poll(() => states.includes('stopped'), { timeout: 15_000 }).toBe(true);
  return cdp;
}

let moves = 0;
// Fly somewhere new each call so Cesium must request tiles it has never loaded.
async function moveCamera(page: Page) {
  const n = ++moves;
  await page.evaluate(
    (i) => window.__setView!(10 + i * 7.3, 20 + ((i * 11) % 40), 800_000 + i * 90_000),
    n,
  );
}

async function exerciseTiles(page: Page) {
  await resetStats(page);
  for (let i = 0; i < 3; i++) {
    await moveCamera(page);
    await page.waitForTimeout(1500);
  }
  await expect.poll(async () => (await getStats(page)).ok, { timeout: 60_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(3000);
  const stats = await getStats(page);
  expect(stats.unauthorized, `unauthorized tile requests: ${JSON.stringify(stats)}`).toBe(0);
  expect(stats.ok).toBeGreaterThan(0);
}

test('tiles stay authenticated after the service worker is stopped', async ({ page }) => {
  await loadApp(page);
  await stopServiceWorker(page);
  await exerciseTiles(page);
});

test('expired token recovers via onTokenExpired after the service worker is stopped', async ({ page }) => {
  await loadApp(page);
  await page.evaluate(() => window.__expireToken!());
  await stopServiceWorker(page);
  await exerciseTiles(page);
  expect(await page.evaluate(() => window.__expiredCallbackCount)).toBeGreaterThan(0);
});

test('tiles stay authenticated after reload following a service worker stop', async ({ page }) => {
  await loadApp(page);
  await stopServiceWorker(page);
  await page.reload();
  await page.waitForFunction(() => window.__sentinelReady === true && !!window.__viewer, null, { timeout: 60_000 });
  await stopServiceWorker(page);
  await exerciseTiles(page);
});
