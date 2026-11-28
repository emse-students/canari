#!/usr/bin/env bun
/**
 * THE MAIL RELAY'S nginx LOCATION KEEPS ITS SHAPE (docs/wiki/mail-client-transport.md#the-relay).
 *
 * `location = /api/mail/relay` is a WebSocket the gateway pipes to the school mailbox. Each line
 * checked here is one whose loss changes what the route is, silently:
 *
 * - its opens are rate limited per client address (`limit_req zone=mail_relay`, a zone keyed by the
 *   address, `limit_req_status 429`, a refusal logged at `warn`): without it a loop or a flood of
 *   upgrades each costs the gateway a token check and an eligibility answer;
 * - it carries the upgrade headers and the same auth_request lines as `/api/ws`;
 * - the gateway's idle deadline (`IDLE_DEADLINE` in apps/chat-gateway/src/mail_relay.rs) stays
 *   CLEARLY BELOW every hop that cuts a silent connection - nginx's own bound
 *   (`proxy_read_timeout`) and the Cloudflare edge's (`CLOUDFLARE_EDGE_IDLE_S` below: its proxy read
 *   timeout, 100 s, which also ends an idle proxied WebSocket) - by `MARGIN_S`, so an idle
 *   connection ends with the relay's close code, which the client reads as an ordinary end, and
 *   never with a hop's cut, which it reads as an unexplained 1006.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (...p) => readFileSync(join(REPO, ...p), 'utf8');

const NGINX = read('infrastructure', 'local', 'Dockerfile.frontend');
const RELAY = read('apps', 'chat-gateway', 'src', 'mail_relay.rs');

/** The Cloudflare edge's idle bound on a proxied connection, in seconds (its proxy read timeout). */
const CLOUDFLARE_EDGE_IDLE_S = 100;
/** How far below every hop the relay's idle close must fall, so the two never race. */
const MARGIN_S = 10;

const failures = [];
const need = (cond, what) => {
  if (!cond) failures.push(what);
};

need(
  /limit_req_zone \$binary_remote_addr zone=mail_relay:\S+ rate=\d+r\/s;/.test(NGINX),
  'no mail_relay limit_req_zone keyed by the client address'
);

const start = NGINX.indexOf('location = /api/mail/relay {');
need(start >= 0, 'no `location = /api/mail/relay`');
const block = start >= 0 ? NGINX.slice(start, NGINX.indexOf('\n    }', start)) : '';

for (const line of [
  'limit_req zone=mail_relay burst=',
  'limit_req_status 429;',
  'limit_req_log_level warn;',
  'auth_request /internal/auth/verify;',
  'proxy_set_header Upgrade $http_upgrade;',
  'proxy_set_header Connection "upgrade";',
  'proxy_pass http://$target_chat_gateway;',
]) {
  need(block.includes(line), `the relay location lost \`${line}\``);
}

const nginxRead = Number(block.match(/proxy_read_timeout (\d+)s;/)?.[1]);
const idle = Number(RELAY.match(/pub const IDLE_DEADLINE: Duration = Duration::from_secs\((\d+)\);/)?.[1]);
need(Number.isFinite(nginxRead), 'the relay location names no proxy_read_timeout in seconds');
need(Number.isFinite(idle), 'mail_relay.rs names no IDLE_DEADLINE in seconds');
for (const [hop, bound] of [
  ['nginx (proxy_read_timeout)', nginxRead],
  ['the Cloudflare edge', CLOUDFLARE_EDGE_IDLE_S],
]) {
  need(
    idle + MARGIN_S <= bound,
    `the relay's idle deadline (${idle} s) must end a silent connection at least ${MARGIN_S} s before ${hop} does (${bound} s)`
  );
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(
  'mail-relay-route: rate limited per address, upgrade and auth lines kept, idle ends before nginx and the Cloudflare edge'
);
