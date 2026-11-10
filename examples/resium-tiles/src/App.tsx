import { getSecurityStatus } from '@reearth/sentinel';
import { Color, UrlTemplateImageryProvider, type Viewer as CesiumViewer } from 'cesium';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageryLayer, Viewer } from 'resium';

const TILE_ORIGIN: string = import.meta.env.VITE_TILE_ORIGIN ?? 'http://localhost:8788';

interface Stats {
  ok: number;
  unauthorized: number;
  byZoom: Record<string, { ok: number; unauthorized: number }>;
}

type SwState = { controller: string; registration: string; authenticated: string };

async function readSw(): Promise<SwState> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const status = await getSecurityStatus().catch(() => null);
  return {
    controller: navigator.serviceWorker.controller?.state ?? 'none',
    registration: reg?.active?.state ?? 'no active worker',
    authenticated: status ? String(status.isAuthenticated) : 'unknown',
  };
}

const hud: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  left: 8,
  zIndex: 10,
  background: 'rgba(0,0,0,0.75)',
  color: '#eee',
  font: '12px/1.4 monospace',
  padding: 10,
  width: 330,
  borderRadius: 6,
};

export function App() {
  const provider = useMemo(
    () =>
      new UrlTemplateImageryProvider({
        url: `${TILE_ORIGIN}/imagery/test/{z}/{x}/{y}.png`,
        maximumLevel: 18,
      }),
    [],
  );
  const viewerRef = useRef<{ cesiumElement?: CesiumViewer } | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [sw, setSw] = useState<SwState | null>(null);
  const [expired, setExpired] = useState(0);
  const [showIdle, setShowIdle] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      const v = viewerRef.current?.cesiumElement;
      if (v && window.__viewer !== v) window.__viewer = v;
    }, 100);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const tick = async () => {
      setSw(await readSw());
      setExpired(window.__expiredCallbackCount ?? 0);
      try {
        setStats((await (await fetch(`${TILE_ORIGIN}/stats`, { cache: 'no-store' })).json()) as Stats);
      } catch {
        setStats(null);
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const expireToken = async () => {
    await window.__expireToken?.();
  };

  return (
    <>
      <div style={hud} data-testid="hud">
        <b>Sentinel tile HUD</b>
        <div>SW controller: {sw?.controller ?? '...'}</div>
        <div>SW active: {sw?.registration ?? '...'}</div>
        <div>Authenticated: {sw?.authenticated ?? '...'}</div>
        <div>onTokenExpired calls: {expired}</div>
        <div>
          Tile server: ok <b>{stats?.ok ?? '?'}</b> / 401 <b style={{ color: stats?.unauthorized ? '#f66' : undefined }}>{stats?.unauthorized ?? '?'}</b>
        </div>
        <div>
          byZoom:{' '}
          {stats
            ? Object.entries(stats.byZoom)
                .map(([z, c]) => `z${z}:${c.ok}/${c.unauthorized}`)
                .join(' ') || '-'
            : '?'}{' '}
          (ok/401)
        </div>
        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={() => setShowIdle((s) => !s)}>Simulate idle SW stop</button>
          <button onClick={expireToken}>Expire token</button>
          <button onClick={() => void fetch(`${TILE_ORIGIN}/stats/reset`, { method: 'POST' })}>Reset stats</button>
        </div>
        {showIdle && (
          <p style={{ margin: '6px 0 0' }}>
            A page cannot stop its own service worker. Open <code>chrome://serviceworker-internals</code> and click Stop on
            the worker for this origin, or DevTools &gt; Application &gt; Service Workers &gt; Stop. Then pan or zoom
            the globe: new tile requests restart the worker. The 401 count must stay flat.
          </p>
        )}
      </div>
      <Viewer
        full
        ref={viewerRef as never}
        baseLayer={false}
        baseLayerPicker={false}
        geocoder={false}
        homeButton={false}
        sceneModePicker={false}
        navigationHelpButton={false}
        animation={false}
        timeline={false}
        fullscreenButton={false}
        infoBox={false}
        selectionIndicator={false}
        skyBox={false}
        skyAtmosphere={false}
        scene3DOnly
      >
        <GlobeColor />
        <ImageryLayer imageryProvider={provider} />
      </Viewer>
    </>
  );
}

function GlobeColor() {
  useEffect(() => {
    const id = setInterval(() => {
      const v = window.__viewer;
      if (v) {
        v.scene.globe.baseColor = Color.DARKSLATEGRAY;
        clearInterval(id);
      }
    }, 100);
    return () => clearInterval(id);
  }, []);
  return null;
}
