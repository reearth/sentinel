import { registerAssetSecurity, updateToken } from '@reearth/sentinel';
import { Cartesian3, Ion } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';

declare global {
  interface Window {
    __sentinelReady?: boolean;
    __expireToken?: () => Promise<void>;
    __setView?: (lon: number, lat: number, height: number) => void;
    __viewer?: import('cesium').Viewer;
    __expiredCallbackCount?: number;
  }
}

const TILE_ORIGIN: string = import.meta.env.VITE_TILE_ORIGIN ?? 'http://localhost:8788';

Ion.defaultAccessToken = '';

interface AppConfig {
  token: string;
  ttlMs: number;
}

async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  return (await res.json()) as AppConfig;
}

async function refreshToken(): Promise<void> {
  const t = await fetchConfig();
  await updateToken({ accessToken: t.token, expiresAt: Date.now() + t.ttlMs });
}

async function boot() {
  window.__expiredCallbackCount = 0;
  await registerAssetSecurity({
    proxyUrl: TILE_ORIGIN,
    protectedDomains: [new URL(TILE_ORIGIN).host],
    namespace: 'reearth-visualizer',
    assetPatterns: { rasterTiles: /\/(?:cesium-mesh|imagery|google3d|v1\/3dtiles)\// },
    tokenConfig: { memoryCacheTTL: 300000, refreshThreshold: 60000 },
    debug: true,
    onTokenExpired: async () => {
      window.__expiredCallbackCount = (window.__expiredCallbackCount ?? 0) + 1;
      await refreshToken();
    },
  });
  await refreshToken();
  window.__expireToken = async () => {
    await updateToken({ accessToken: 'expired-token', expiresAt: Date.now() - 1000 });
  };
  window.__setView = (lon, lat, height) =>
    window.__viewer?.camera.setView({ destination: Cartesian3.fromDegrees(lon, lat, height) });
  window.__sentinelReady = true;
  createRoot(document.getElementById('root')!).render(<App />);
}

void boot();
