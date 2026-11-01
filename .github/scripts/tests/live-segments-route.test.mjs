#!/usr/bin/env bun
/**
 * A LIVE SEGMENT IS ANSWERED BY CANARI'S nginx, NOT BY media-service, FROM THE SECOND VIEWER ON
 * (WP-L4, docs/wiki/services/lives.md "Serving a segment" and "The viewer cap").
 *
 * The behaviour was read once on a running container (a stub upstream, 20 concurrent fetches of one
 * segment = ONE upstream request; a query string neither busts the cache nor reaches the upstream;
 * the wiki records the run). That reading proves one build; this gate keeps the SHAPE that produced
 * it, because each line below is one whose loss silently turns the cache off:
 *
 * - `proxy_buffering on` in the location: it is OFF server-wide, and nginx never caches an
 *   unbuffered response - the cache would be configured and empty;
 * - `proxy_cache_key $uri` and a `proxy_pass` ending in `$uri`: with the default key a `?x=1` per
 *   request is a fresh miss each time, and an unauthenticated route is the one anybody can hammer;
 * - `proxy_cache_lock on`: without it, viewers arriving together each reach media-service;
 * - the cookie, the token, the origin and the range cleared: the upstream request is the same for
 *   every viewer, or the cache stores a per-viewer variant;
 * - no `auth_request`: a token check per fetch is exactly what the route exists to avoid;
 * - the client's Cache-Control `private, max-age=120`: no shared cache between here and the viewer
 *   keeps a segment, and the viewer's own keeps one no longer than this cache does (register C16);
 * - the media-service route checks the live switch and no token, and answers the CANONICAL path only.
 *
 * AND NOTHING UNDER THE PREFIX ESCAPES THE CACHE (review of #2105). Until then the segment location
 * was one regex beside `location /api/media/public/`, so every OTHER spelling of a segment - an
 * upper-case id, a trailing slash - fell into that generic location: no cache, no limit, the store
 * once per request (Express 5 matched both). So this file does not grep for the fix, it RUNS nginx's
 * location selection (exact, longest prefix, `^~`, nested, regexes in order - ngx_http_core_find_location)
 * over the server block it parses, for a set of spellings, and asserts each one lands in the cached
 * location or in the `^~` guard that answers 404. The same probes were read once on the real image
 * against a stub upstream (lives.md, "Serving a segment").
 *
 * The regex is matched with PCRE's semantics, not JavaScript's: PCRE's `$` ALSO matches before a
 * final newline (a trailing %0A matched the cached location and `$uri` carried a raw LF upstream -
 * the second review of #2105), JavaScript's does not, so a `$` is translated to `(?=\n?$)` and
 * the location must end in `\z` (true end) to pass the newline probes.
 *
 * And the BYTES per address: limit_req counts requests, so `limit_conn` and `limit_rate` bound
 * them. `limit_conn` IS the viewer cap (a full audience behind one campus address is never
 * refused), the rate is at least twice a viewer's bitrate (a player can catch up), and the product
 * stays within TWICE the live share of the uplink - the stated trade-off (lives.md): both cannot fit
 * the share itself, honest viewers are not throttled, and the per-address bound is coarse.
 * A refusal logs at `warn`, never `error`.
 *
 * And the CONNECTION BUDGET: the host proxy in front of us is the DSI's (one host-wide connection
 * budget shared by every site on it, realtime-media-feasibility.md section 5), and this file must
 * not raise a worker limit to make room. A seated viewer holds at most FOUR of them (its app
 * connection, its WebSocket and that socket's upstream leg, one segment fetch in flight), so the
 * viewer cap may use at most a quarter of the budget.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8');

const NGINX = read('infrastructure', 'local', 'Dockerfile.frontend');
const MEDIA = read('apps', 'media-service', 'src', 'media', 'media.controller.ts');
const LIVES_CONTROLLER = read('apps', 'social-service', 'src', 'lives', 'lives.controller.ts');
const CONSTANTS = read('apps', 'social-service', 'src', 'lives', 'live.constants.ts');

const HOST_CONNECTION_BUDGET = 1500;
const CONNECTIONS_PER_VIEWER = 4;

const failures = [];
const need = (cond, what) => {
  if (!cond) failures.push(what);
};

// ── the cache zone, at http level ───────────────────────────────────────────────────────────────
const zone = NGINX.match(
  /proxy_cache_path (\S+) [^\n]*keys_zone=live_segments:(\S+) ([^\n]*?)\\n\\/
);
need(zone, 'no proxy_cache_path with keys_zone=live_segments');
if (zone) {
  need(
    /max_size=\d+[mg]/.test(zone[3]),
    'the live cache has no max_size: it would grow to the disk'
  );
  need(/inactive=\d+[sm]\b/.test(zone[3]), 'the live cache has no short inactive');
  need(/use_temp_path=off/.test(zone[3]), 'the live cache writes through a temp path');
}

// ── the location ─────────────────────────────────────────────────────────────────────────────────
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const head = `location ~ "^/api/media/public/live/${UUID}/${UUID}\\\\z" {`;
const at = NGINX.indexOf(head);
need(at >= 0, `the segment location is gone or no longer matches two lower-case uuids:\n  ${head}`);
const block = at >= 0 ? NGINX.slice(at, NGINX.indexOf('\n    }\\n\\', at)) : '';
for (const line of [
  'limit_except GET { deny all; }',
  'limit_req zone=lives_segments',
  'proxy_cache live_segments;',
  'proxy_cache_key $uri;',
  'proxy_cache_lock on;',
  'proxy_buffering on;',
  'proxy_force_ranges on;',
  'limit_conn_log_level warn;',
  'limit_req_log_level warn;',
  'proxy_ignore_headers Cache-Control Expires Set-Cookie Vary',
  'proxy_hide_header Cache-Control;',
  'proxy_hide_header Set-Cookie;',
  'proxy_set_header Cookie "";',
  'proxy_set_header Authorization "";',
  'proxy_set_header Origin "";',
  'proxy_set_header Range "";',
  'proxy_set_header X-User-Id "";',
  'proxy_set_header X-Internal-Token "";',
  'set $upstream_media_live media-service:3011;',
  'proxy_pass http://$upstream_media_live$uri;',
  'add_header Cache-Control "private, max-age=120";',
  'add_header X-Canari-Cache $upstream_cache_status always;',
  'add_header Access-Control-Allow-Origin $api_error_cors_origin always;',
  'include /etc/nginx/snippets/csp.conf;',
  'add_header X-Content-Type-Options "nosniff" always;',
  'add_header X-Frame-Options "DENY" always;',
]) {
  need(block.includes(line), `the segment location lacks: ${line}`);
}
need(!/auth_request/.test(block), 'the segment location must not call auth_request');
need(
  !/immutable/.test(block),
  'a segment is not immutable to the viewer: it must not outlive its live'
);
need(
  /proxy_cache_valid 200 \d+[sm];/.test(block),
  'the segment location keeps a 200 for no bounded time'
);
need(
  /limit_req_zone \$binary_remote_addr zone=lives_segments:/.test(NGINX),
  'no lives_segments limit zone'
);
need(
  !/worker_connections/.test(NGINX),
  'Dockerfile.frontend sets worker_connections - the budget is the host proxy, not this image'
);
need(
  /pid \/var\/run\/nginx\.pid;/.test(read('infrastructure', 'edge', 'nginx.conf')),
  'the edge lost its pid file, which its healthcheck reads (#2099)'
);
need(
  /\n    listen 80;\\n\\/.test(NGINX),
  'the frontend no longer listens on 80, where the edge sends'
);

// ── the media-service route ──────────────────────────────────────────────────────────────────────
const route = MEDIA.match(
  /@Get\('public\/live\/:liveId\/:name'\)\s*async downloadLiveSegment\(([\s\S]*?)\n  \}\n/
);
need(route, "media-service has no @Get('public/live/:liveId/:name') downloadLiveSegment");
if (route) {
  need(/this\.assertLiveEnabled\(\)/.test(route[1]), 'the segment route ignores LIVE_ENABLED');
  need(!/verifyToken/.test(route[1]), 'the segment route checks a token: nginx could not cache it');
}
need(
  route && /LiveSegmentsService\.isCanonicalSegmentPath\(req\.originalUrl/.test(route[1]),
  'the segment route answers a non-canonical path: Express 5 ignores case and a trailing slash'
);
need(
  !/@Get\('live\/:liveId\/:name'\)/.test(MEDIA),
  'the old JWT segment route is back: two routes for the same bytes'
);

// ── the manifest is never cached ─────────────────────────────────────────────────────────────────
need(
  /@Get\(':id\/manifest'\)\s*@Header\('Cache-Control', 'no-store'\)/.test(LIVES_CONTROLLER),
  'the manifest is not no-store'
);

// ── the viewer cap fits the host's connection budget ────────────────────────────────────────────
const num = (name) => {
  const m = CONSTANTS.match(new RegExp(`export const ${name} = ([0-9_.]+);`));
  return m ? Number(m[1].replace(/_/g, '')) : NaN;
};
const cap = Math.floor(
  (num('LIVE_HOST_EGRESS_BPS') * num('LIVE_EGRESS_SHARE')) / num('LIVE_VIEWER_BITRATE_BPS')
);
need(Number.isInteger(cap) && cap > 0, `the viewer cap cannot be computed from live.constants.ts`);
need(
  cap * CONNECTIONS_PER_VIEWER <= HOST_CONNECTION_BUDGET / 4,
  `the viewer cap (${cap}) x ${CONNECTIONS_PER_VIEWER} connections is over a quarter of the host's ` +
    `${HOST_CONNECTION_BUDGET}`
);

// ── the bytes one address may pull ──────────────────────────────────────────────────────────────
const connN = Number(block.match(/limit_conn lives_segments_conn (\d+);/)?.[1]);
const rateBps = Number(block.match(/limit_rate (\d+);/)?.[1]) * 8;
need(
  /limit_conn_zone \$binary_remote_addr zone=lives_segments_conn:/.test(NGINX),
  'no per-address connection zone for the segments'
);
need(Number.isInteger(connN) && connN > 0, 'the segment location has no limit_conn');
need(rateBps > 0, 'the segment location has no limit_rate in plain bytes per second');
const viewerBps = num('LIVE_VIEWER_BITRATE_BPS');
need(
  connN === cap,
  `limit_conn (${connN}) is not the viewer cap (${cap}): a full audience behind one address is refused`
);
need(rateBps >= 2 * viewerBps, `limit_rate (${rateBps} b/s) leaves a player no room to catch up`);
need(
  connN * rateBps <= 2 * cap * viewerBps,
  `one address may pull ${connN} x ${rateBps} b/s, over twice the live share (${cap} x ${viewerBps})`
);

// ── nginx's own location selection, over the parsed server block ────────────────────────────────
/**
 * The locations of the `server` block, as a tree: `{ mod, arg, re, children, body }`. The conf is
 * a printf body (each line ends in a literal `\n\`), so a line is read up to that marker; quoted
 * strings and comments are blanked before the braces are counted (the uuid regex holds `{8}`).
 */
function parseLocations(conf) {
  // The printf body: strip the `\n\` line ends, then unescape `\\` and `%%` as printf does.
  const lines = conf.split('\n').map((l) =>
    l
      .replace(/\\n\\$/, '')
      .replace(/\\\\/g, '\\')
      .replace(/%%/g, '%')
  );
  const start = lines.findIndex((l) => /^server \{$/.test(l.trim()));
  const root = { children: [], body: [] };
  const stack = [root];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (stack.length === 0) break;
    const bare = line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/#.*$/, '');
    const head = line.match(/^location\s+(=|\^~|~\*|~)?\s*("([^"]+)"|\S+)\s*\{$/);
    if (head) {
      const mod = head[1] ?? '';
      const arg = head[3] ?? head[2];
      const loc = {
        mod,
        arg,
        re: mod.startsWith('~') ? new RegExp(pcreToJs(arg), mod === '~*' ? 'i' : '') : null,
        children: [],
        body: [],
      };
      stack[stack.length - 1].children.push(loc);
      stack.push(loc);
      continue;
    }
    const opens = (bare.match(/\{/g) ?? []).length;
    const closes = (bare.match(/\}/g) ?? []).length;
    if (opens === closes) {
      if (bare.trim()) stack[stack.length - 1].body.push(line);
      continue;
    }
    if (closes > opens) {
      for (let i = 0; i < closes - opens; i += 1) stack.pop();
      continue;
    }
    // A non-location block (if, limit_except over several lines): kept as body, depth tracked.
    const block = { mod: 'block', arg: line, re: null, children: [], body: [] };
    stack[stack.length - 1].body.push(line);
    stack.push(block);
  }
  return root;
}

/**
 * An nginx (PCRE) location regex as JavaScript matches it: a final `\z` is the true end (`$` in
 * JavaScript without `m`), and a final `$` is PCRE's "end, or before a final newline".
 */
function pcreToJs(re) {
  if (re.endsWith('\\z')) return re.slice(0, -2) + '$';
  if (re.endsWith('$') && !re.endsWith('\\$')) return re.slice(0, -1) + '(?=\\n?$)';
  return re;
}

/** ngx_http_core_find_location, for one level and its nested ones: `{ loc, final }`. */
function findLocation(level, uri) {
  const statics = level.children.filter(
    (l) => !l.re && l.mod !== 'block' && !l.arg.startsWith('@')
  );
  const exact = statics.find((l) => l.mod === '=' && l.arg === uri);
  if (exact) return { loc: exact, final: true };
  const prefix = statics
    .filter((l) => l.mod !== '=' && uri.startsWith(l.arg))
    .sort((a, b) => b.arg.length - a.arg.length)[0];
  let chosen = prefix ?? null;
  if (prefix) {
    const nested = findLocation(prefix, uri);
    if (nested.final) return nested;
    if (nested.loc) chosen = nested.loc;
    if (prefix.mod === '^~') return { loc: chosen, final: false };
  }
  for (const r of level.children.filter((l) => l.re)) {
    if (r.re.test(uri)) {
      const nested = findLocation(r, uri);
      return { loc: nested.loc ?? r, final: true };
    }
  }
  return { loc: chosen, final: false };
}

const server = parseLocations(NGINX);
const PREFIX = '/api/media/public/live/';
const guard = server.children.find((l) => l.mod === '^~' && l.arg === PREFIX);
need(
  guard,
  `no \`location ^~ ${PREFIX}\`: a segment spelled otherwise falls to /api/media/public/`
);
if (guard) {
  need(
    guard.children.length === 1 && guard.children[0].re,
    'the ^~ guard must hold exactly ONE nested location, the canonical regex'
  );
  need(
    guard.body.some((l) => /^return 404 /.test(l)),
    'the ^~ guard does not answer 404 for what its regex refuses'
  );
  need(!guard.body.some((l) => /proxy_pass/.test(l)), 'the ^~ guard proxies: only its regex may');
}
const L1 = '11111111-1111-4111-8111-111111111111';
const S1 = '33333333-3333-4333-8333-333333333333';
const canonicalAt = findLocation(server, `${PREFIX}${L1}/${S1}`).loc;
need(
  canonicalAt && canonicalAt.body.includes('proxy_cache live_segments;'),
  'the canonical segment path does not land in the cached location'
);
for (const probe of [
  `${PREFIX}${L1.toUpperCase().replace(/^1/, 'A')}/${S1}`,
  `${PREFIX}${L1}/${S1.replace(/3$/, 'A')}`,
  `${PREFIX}${L1}/${S1}/`,
  `${PREFIX}${L1}/${S1}/x`,
  // $uri is DECODED: %0A, %0D%0A and %00 arrive as these characters.
  `${PREFIX}${L1}/${S1}\n`,
  `${PREFIX}${L1}/${S1}\r\n`,
  `${PREFIX}${L1}/${S1}\nx`,
  `${PREFIX}${L1}/${S1}\0`,
  `${PREFIX}${L1}/${S1}.mjs`,
  `${PREFIX}${L1}`,
  `${PREFIX}${L1}/`,
  PREFIX,
  `${PREFIX}x.mjs`,
]) {
  const at = findLocation(server, probe).loc;
  need(
    at === guard,
    `${JSON.stringify(probe)} is answered by \`location ${at?.mod ?? ''} ${at?.arg ?? '(none)'}\`, not the ^~ guard's 404`
  );
}

if (failures.length > 0) {
  console.error(`live-segments-route: ${failures.length} failure(s)\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `live-segments-route: segments cached by nginx, unauthenticated, manifest no-store; ` +
    `every other spelling under ${PREFIX} is the ^~ guard's 404; ` +
    `one address <= ${connN} x ${rateBps / 1e6} Mb/s = ${(connN * rateBps) / 1e6} Mb/s; ` +
    `cap ${cap} viewers = ${cap * CONNECTIONS_PER_VIEWER} of ~${HOST_CONNECTION_BUDGET} host connections`
);
