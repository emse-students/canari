#!/usr/bin/env bun
/**
 * WP-L1 live bench - the PC side. NOT shipped, NOT product code: a throwaway instrument kept so the
 * readings on docs/wiki/frontend/modules/live.md can be taken again.
 *
 * It does three jobs, all on one port (default 8787, every interface):
 *
 * - `GET /time` - the bench clock. Every page (phone app WebView over `adb reverse`, iPhone Safari
 *   over the LAN, the PC browser) syncs to it, so a capture time on one device and a display time on
 *   another are compared in ONE clock.
 * - `/m/<liveId>/...` - a STATIC MIRROR of a live: sealed segments stored in memory and served as
 *   files with no auth, which is the WP-L4 shape (nginx serving sealed files). Used when a page
 *   cannot sign in to dev (iPhone Safari), fed by a relay page that is signed in.
 * - `POST /log/<name>` - appends a JSON line to `<out>/<name>.ndjson`, so a run's numbers land on the
 *   PC as they are taken, not when a page is read at the end.
 *
 * Only ciphertext, timings and the bench's own random live keys pass through it. Never a credential.
 *
 * Usage: bun tools/live-bench/server.mjs [--port 8787] [--out <dir>]
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg('port', 8787));
const OUT = arg('out', join(process.cwd(), 'live-bench-out'));
mkdirSync(OUT, { recursive: true });

/** liveId -> { meta, segs: Map<index, { bytes: Uint8Array, at }> } */
const lives = new Map();
const live = (id) => {
  if (!lives.has(id)) lives.set(id, { meta: {}, segs: new Map() });
  return lives.get(id);
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
  'cache-control': 'no-store',
};
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });

const BLANK =
  '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>live bench</title><body style="margin:0;background:#000">';

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname.split('/').filter(Boolean);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/')
      return new Response(BLANK, { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/time') return json({ t: Date.now() });
    if (url.pathname === '/bench.js')
      return new Response(readFileSync(new URL('./bench.js', import.meta.url)), {
        headers: { ...CORS, 'content-type': 'text/javascript' },
      });
    if (p[0] === 'log' && p[1] && req.method === 'POST') {
      const body = await req.text();
      appendFileSync(join(OUT, `${p[1].replace(/[^\w.-]/g, '_')}.ndjson`), body.trim() + '\n');
      return json({ ok: true });
    }
    if (p[0] === 'm' && p[1]) {
      const L = live(p[1]);
      if (p[2] === 'meta') {
        if (req.method === 'POST') Object.assign(L.meta, await req.json());
        return json(L.meta);
      }
      if (p[2] === 'manifest') {
        const idx = [...L.segs.keys()].sort((a, b) => a - b);
        const from = url.searchParams.get('from');
        const pick =
          from === null ? idx.slice(-10) : idx.filter((i) => i >= Number(from)).slice(0, 10);
        return json({
          liveId: p[1],
          nextIndex: idx.length ? idx[idx.length - 1] + 1 : 0,
          serverNow: Date.now(),
          segments: pick.map((i) => ({
            index: i,
            name: String(i),
            bytes: L.segs.get(i).bytes.byteLength,
          })),
        });
      }
      if (p[2] === 'seg' && p[3] !== undefined) {
        const i = Number(p[3]);
        if (req.method === 'POST') {
          L.segs.set(i, { bytes: new Uint8Array(await req.arrayBuffer()), at: Date.now() });
          return json({ index: i });
        }
        const s = L.segs.get(i);
        if (!s) return json({ error: 'no such segment' }, 404);
        return new Response(s.bytes, {
          headers: { ...CORS, 'content-type': 'application/octet-stream' },
        });
      }
    }
    return json({ error: 'not found' }, 404);
  },
});
console.log(`[live-bench] on :${PORT}, logs in ${OUT}`);
