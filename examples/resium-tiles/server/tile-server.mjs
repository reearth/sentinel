import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

const TOKEN = process.env.TOKEN ?? 'test-token';
const PORT = Number(process.env.PORT ?? 8788);

const stats = { ok: 0, unauthorized: 0, byZoom: {} };
const resetStats = () => {
  stats.ok = 0;
  stats.unauthorized = 0;
  stats.byZoom = {};
};

const GLYPHS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '/': ['001', '001', '010', '100', '100'],
};

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

const SIZE = 256;
const zoomColor = (z) => {
  const h = (z * 47) % 360;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (0.55 - 0.3 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
};

function tilePng(z, x, y) {
  const [r, g, b] = zoomColor(z);
  const px = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i++) {
    px[i * 3] = r;
    px[i * 3 + 1] = g;
    px[i * 3 + 2] = b;
  }
  const set = (ix, iy, v) => {
    const o = (iy * SIZE + ix) * 3;
    px[o] = px[o + 1] = px[o + 2] = v;
  };
  for (let i = 0; i < SIZE; i++) {
    for (const [a, c] of [[i, 0], [i, SIZE - 1], [0, i], [SIZE - 1, i]]) set(a, c, 255);
  }
  const text = `${z}/${x}/${y}`;
  const scale = Math.max(2, Math.min(6, Math.floor((SIZE - 16) / (text.length * 4))));
  const startX = Math.floor((SIZE - text.length * 4 * scale) / 2);
  const startY = Math.floor((SIZE - 5 * scale) / 2);
  [...text].forEach((ch, ci) => {
    const glyph = GLYPHS[ch];
    glyph.forEach((row, gy) =>
      [...row].forEach((bit, gx) => {
        if (bit !== '1') return;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++)
            set(startX + (ci * 4 + gx) * scale + dx, startY + gy * scale + dy, 255);
      }),
    );
  });
  const raw = Buffer.alloc((SIZE * 3 + 1) * SIZE);
  for (let row = 0; row < SIZE; row++) {
    raw[row * (SIZE * 3 + 1)] = 0;
    px.copy(raw, row * (SIZE * 3 + 1) + 1, row * SIZE * 3, (row + 1) * SIZE * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
  } else {
    res.setHeader('access-control-allow-origin', '*');
  }
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization');
  res.setHeader('access-control-max-age', '86400');
}

const TILE_RE = /^\/imagery\/test\/(\d+)\/(\d+)\/(\d+)\.png$/;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (url.pathname === '/stats' && req.method === 'GET') {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(stats));
    return;
  }
  if (url.pathname === '/stats/reset' && req.method === 'POST') {
    resetStats();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(stats));
    return;
  }
  const m = TILE_RE.exec(url.pathname);
  if (!m || req.method !== 'GET') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const bucket = (stats.byZoom[z] ??= { ok: 0, unauthorized: 0 });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    stats.unauthorized++;
    bucket.unauthorized++;
    res.statusCode = 401;
    res.setHeader('www-authenticate', 'Bearer');
    res.setHeader('cache-control', 'no-store');
    res.end('unauthorized');
    return;
  }
  stats.ok++;
  bucket.ok++;
  res.statusCode = 200;
  res.setHeader('content-type', 'image/png');
  // no-cache: revalidate so repeated views still hit the server and stay countable.
  res.setHeader('cache-control', 'no-cache');
  res.end(tilePng(z, x, y));
});

server.listen(PORT, () => console.log(`tile server on http://localhost:${PORT} (token "${TOKEN}")`));
