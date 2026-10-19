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
 * - the client's Cache-Control `private` + `immutable`: no shared cache between here and the viewer
 *   keeps a segment past the purge of its live;
 * - the media-service route checks the live switch and no token.
 *
 * And the CONNECTION BUDGET: the host proxy in front of us is the DSI's (~1 500 concurrent
 * connections across every site on it, realtime-media-feasibility.md section 5), and this file must
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
const head = `location ~ "^/api/media/public/live/${UUID}/${UUID}$" {`;
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
  'add_header Cache-Control "private, max-age=3600, immutable";',
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

if (failures.length > 0) {
  console.error(`live-segments-route: ${failures.length} failure(s)\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  `live-segments-route: segments cached by nginx, unauthenticated, manifest no-store; ` +
    `cap ${cap} viewers = ${cap * CONNECTIONS_PER_VIEWER} of ~${HOST_CONNECTION_BUDGET} host connections`
);
