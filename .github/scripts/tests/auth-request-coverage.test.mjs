#!/usr/bin/env bun
/**
 * `auth_request` IDENTIFIES A CALLER. IT REFUSES NOBODY. THIS IS THE GATE THAT SAYS SO.
 *
 * Sixteen `location` blocks in `infrastructure/local/Dockerfile.frontend` carry
 * `auth_request /internal/auth/verify`. That sub-request goes to `/api/auth/verify`, which answers
 * **200 for a logged-out caller too**, carrying `x-logged-in: false` so signed-out pages can
 * render. nginx treats any 2xx as permission granted. So the edge check decorates; the only thing
 * that can refuse anybody is the service's own guard.
 *
 * A config that LOOKS like an access check and is not will mislead every reader, and it did: on
 * 2026-09-10 an audit of the fourteen unaudited locations found four unauthenticated payment routes
 * reaching a LIVE Stripe account and one form read open to anybody. Each was a route whose siblings
 * in the very same file were guarded - an omission, invisible in a diff, that no test named.
 *
 * So this gate asserts the one thing that keeps the edge honest: **every route behind an
 * `auth_request` location either carries authorization, or is DECLARED here with a reason.** A new
 * route with neither fails, by name. A declaration that no longer matches a route also fails, so
 * the list cannot rot into a list of things that used to be true.
 *
 * It is deliberately STATIC. A probe proves one endpoint on one estate at one moment; this proves
 * the shape of every route on every service, in CI, before a deploy exists.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');
const NGINX = join(REPO, 'infrastructure', 'local', 'Dockerfile.frontend');

/**
 * Routes that sit behind an `auth_request` location with NO authorization, deliberately.
 *
 * Each entry is a claim someone has to defend, which is the whole point of writing it down: the
 * alternative is an omission that looks exactly like this and says nothing. `route` is matched
 * against `VERB /full/path` exactly.
 */
const PUBLIC_BY_INTENT = [
  {
    route: 'GET /associations/:id/products',
    why: 'the association shop page renders for a signed-out visitor; x-user-id is optional and only picks the price band',
  },
  {
    route: 'GET /associations/categories',
    why: 'category list for the public associations directory',
  },
  {
    route: 'GET /associations/users/:userId/memberships',
    why: 'public profile - current association memberships',
  },
  {
    route: 'GET /associations/users/:userId/role-history',
    why: 'public profile - past and honorary roles',
  },
  {
    route: 'GET /associations/:id/events',
    why: 'public association agenda; pending events need a signed-in caller and are filtered in the handler',
  },
  {
    route: 'GET /associations/calendar/feed',
    why: 'public aggregated agenda; includePending is honoured only for a caller who is identified',
  },
  {
    route: 'GET /associations/calendar/feed.ics',
    why: 'subscribed by an external calendar client, which cannot carry a session at all',
  },
  {
    route: 'GET /forms/:id/calendar-link',
    why: 'one agenda entry for a form, read by the public association page; never the form contents',
  },
  {
    route: 'GET /users/:id/avatar',
    why: 'an <img> subresource on public pages; an <img> cannot carry a Bearer token',
  },
  {
    route: 'GET /media/public/:id',
    why: 'the public-asset prefix - association logos and event images, served to an <img> on pages a signed-out visitor sees; every other media route needs the JWT',
  },
  {
    route: 'POST /payments/webhook',
    why: 'Stripe calls it, so it can carry no session - it is authorized by the stripe-signature HMAC and refuses an unsigned body with 503 in production',
  },
  {
    route: 'GET /channels/health',
    why: 'liveness',
  },
  {
    route: 'GET /posts/health',
    why: 'liveness',
  },
];

/** The route decorators, as one pattern - used both to find a handler and to find where it ends. */
const ROUTE_DECORATOR = /@(Get|Post|Put|Patch|Delete|All|Head|Options)\(/;

/**
 * Whether a line is prose rather than code.
 *
 * A DECORATOR QUOTED IN A COMMENT IS NOT A ROUTE. `media.controller.ts` explains three times why
 * `internal/:id` is declared before the catch-all `@Get(':id')`, and each of those sentences was
 * read as a route of its own: three phantoms that no service serves, reported as unauthorized -
 * and worse, each one ended the REAL handler above it early, so ten routes lost the `verifyToken`
 * call that authorizes them. A scanner that reads comments as code fails in both directions at
 * once, and the direction that matters is the one where it calls an open route closed.
 */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/** In-body authorization idioms. Authorization here is not always a decorator, and counting
 *  decorators counts decorators - `POST /associations/:id/stripe-account` has none and calls
 *  `assertInternalSecret()` as its first statement. */
const IN_BODY_AUTH = [
  'assertInternalSecret',
  'assertContentModerator',
  'assertGlobalAdmin',
  'assertCanManageAssociation',
  'assertDistributionScope',
  'assertApiKey',
  'assertCercleApiKey',
  'verifyPushSecretAuth',
  'verifyToken',
  'verifyLydiaRequestCallback',
  'requireAccessToken',
  // `GET /mls/link-preview/image` goes into an `<img src>`, which carries no Bearer and, on
  // `tauri://localhost`, no cookie - a guard would refuse every mobile reader. It verifies a
  // short-lived ticket an authenticated call minted instead, as its first statement.
  'verifyPreviewTicket',
];

/** The nginx locations carrying `auth_request`, and the upstream each proxies to. */
function authRequestLocations() {
  const raw = readFileSync(NGINX, 'utf8');
  // The file is a Dockerfile heredoc: every config line ends with a literal `\n\`.
  const lines = raw.split('\n').map((l) => l.replace(/\\n\\\s*$/, '').trimEnd());
  const out = [];
  let current = null;
  for (const line of lines) {
    const loc = line.match(/^\s*location\s+(?:=\s+)?(\/\S*)\s*\{/);
    if (loc) {
      current = { path: loc[1], authRequest: false, upstream: null, rewriteTo: null };
      continue;
    }
    if (!current) continue;
    if (/auth_request\s+\/internal\/auth\/verify/.test(line)) current.authRequest = true;
    const up = line.match(/^\s*set\s+\$upstream_\w+\s+([a-z0-9-]+):\d+/);
    if (up) current.upstream = up[1];
    // `rewrite ^/api/call(.*) /ws$1 break;` - what the upstream is asked for is NOT the location
    // path. Reading the path alone reported call-service as serving nothing under `/api/call`.
    const rw = line.match(/^\s*rewrite\s+\^(\S+?)\(\.\*\)\s+(\/\S*?)\$1\s+break;/);
    if (rw) current.rewriteTo = rw[2];
    if (/^\s*\}/.test(line)) {
      if (current.authRequest) out.push(current);
      current = null;
    }
  }
  return out;
}

/** Every Nest route in `dir`, as `{ route, authorized, file, line }`. */
function nestRoutes(dir) {
  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (name !== 'node_modules') walk(p);
      } else if (name.endsWith('.controller.ts')) {
        files.push(p);
      }
    }
  })(dir);

  const routes = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const src = lines.join('\n');
    const prefix = (src.match(/@Controller\(([^)]*)\)/)?.[1] ?? '').trim().replace(/['"]/g, '');
    const classIdx = lines.findIndex((l) => l.startsWith('export class'));
    const classGuard = lines
      .slice(0, classIdx < 0 ? lines.length : classIdx)
      .some((l) => l.includes('@UseGuards'));

    for (let i = 0; i < lines.length; i++) {
      if (isCommentLine(lines[i])) continue;
      const m = lines[i].match(/@(Get|Post|Put|Patch|Delete|All|Head|Options)\(([^)]*)\)/);
      if (!m) continue;
      const verb = m[1].toUpperCase();
      const path = m[2].trim().replace(/['"]/g, '');

      const deco = [];
      for (let j = i - 1; j >= 0; j--) {
        const t = lines[j].trim();
        if (!(t.startsWith('@') || t.startsWith('*') || t.startsWith('/**') || t === '')) break;
        deco.push(lines[j]);
      }
      let k = i + 1;
      while (k < lines.length && lines[k].trim().startsWith('@')) deco.push(lines[k++]);

      // THE BODY ENDS WHERE THE NEXT ROUTE'S DECORATORS BEGIN, not a fixed number of lines later.
      // A 60-line window swept into the handlers below and credited `GET /posts/health` - which
      // has no guard of any kind - with an idiom belonging to a route further down the file. It is
      // the same trap as crediting `verify-session` with a method called `verifySession`: reading
      // past a handler reads somebody else's authorization, and an over-credit here is a route
      // this gate reports as closed while it answers anybody.
      let end = k;
      while (end < lines.length && !(ROUTE_DECORATOR.test(lines[end]) && !isCommentLine(lines[end]))) end++;
      while (end > k && /^\s*(@|\*|\/\*\*|$)/.test(lines[end - 1])) end--;
      const body = lines.slice(k, end).join('\n');
      const authorized =
        classGuard ||
        deco.some((d) => d.includes('@UseGuards')) ||
        IN_BODY_AUTH.some((idiom) => body.includes(idiom));

      const full = `/${prefix}/${path}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      routes.push({ route: `${verb} ${full}`, authorized, file, line: i + 1 });
    }
  }
  return routes;
}

/** Every route the Rust gateway registers, from its own router. */
function axumRoutes(mainRs) {
  return [...readFileSync(mainRs, 'utf8').matchAll(/\.route\("([^"]+)"/g)].map((m) => m[1]);
}

// ── The assertions ───────────────────────────────────────────────────────────────────────────────

const failures = [];
const locations = authRequestLocations();

if (locations.length < 10) {
  failures.push(
    `parsed only ${locations.length} auth_request locations from ${NGINX} - the parser and the config disagree, which is a failure of this gate rather than a pass`
  );
}

/** Nest services, and the `/api` prefix nginx strips before proxying. */
const NEST = {
  'chat-delivery-service': join(REPO, 'apps', 'chat-delivery-service', 'src'),
  'core-service': join(REPO, 'apps', 'core-service', 'src'),
  'media-service': join(REPO, 'apps', 'media-service', 'src'),
  'social-service': join(REPO, 'apps', 'social-service', 'src'),
  'call-service': join(REPO, 'apps', 'call-service', 'src'),
};

const allRoutes = new Map();
for (const [service, dir] of Object.entries(NEST)) {
  for (const r of nestRoutes(dir)) {
    if (!allRoutes.has(r.route)) allRoutes.set(r.route, []);
    allRoutes.get(r.route).push({ ...r, service });
  }
}

const declared = new Set(PUBLIC_BY_INTENT.map((e) => e.route));
const matchedDeclarations = new Set();

for (const loc of locations) {
  const prefix = loc.path.replace(/^\/api/, '').replace(/\/$/, '');
  if (!NEST[loc.upstream]) continue; // the Rust gateway is asserted separately, below

  const behind = [...allRoutes.entries()].filter(([route]) => {
    const path = route.split(' ')[1];
    return path === prefix || path.startsWith(`${prefix}/`);
  });

  for (const [route, hits] of behind) {
    if (hits.some((h) => h.authorized)) continue;
    if (declared.has(route)) {
      matchedDeclarations.add(route);
      continue;
    }
    const where = hits.map((h) => `${h.file.replace(REPO, '').replace(/\\/g, '/')}:${h.line}`);
    failures.push(
      `${route} sits behind nginx location "${loc.path}" (auth_request) with NO authorization and NO declaration - ${where.join(', ')}`
    );
  }
}

// EVERY DECLARATION MUST STILL BE DOING WORK, and "the route still exists" is not that test.
// Checking existence alone let three entries survive the day their routes were guarded: the loop
// above skips an authorized route before it ever consults the list, so a declaration that has
// become unnecessary is simply never read. A reason nobody needs reads exactly like a reason
// somebody does, which is how a list of deliberate exceptions turns into a list of stale ones.
for (const entry of PUBLIC_BY_INTENT) {
  if (matchedDeclarations.has(entry.route)) continue;
  failures.push(
    !allRoutes.has(entry.route)
      ? `PUBLIC_BY_INTENT names "${entry.route}", which no controller declares any more - delete the entry rather than leaving a reason for a route nobody serves`
      : `PUBLIC_BY_INTENT names "${entry.route}", which is now authorized or sits behind no auth_request location - the declaration buys nothing and must be deleted`
  );
}

// An `auth_request` location whose upstream serves nothing under it guards nothing, and reads in
// the config as though it does. `/api/groups` was exactly that until 2026-09-10.
const AXUM = {
  'chat-gateway': axumRoutes(join(REPO, 'apps', 'chat-gateway', 'src', 'main.rs')),
  'call-service': axumRoutes(join(REPO, 'apps', 'call-service', 'src', 'main.rs')),
};
for (const loc of locations) {
  const prefix = (loc.rewriteTo ?? loc.path).replace(/\/$/, '');
  const served = AXUM[loc.upstream]
    ? AXUM[loc.upstream].some((r) => r === prefix || r.startsWith(`${prefix}/`))
    : [...allRoutes.keys()].some((route) => {
        const path = `/api${route.split(' ')[1]}`;
        return path === prefix || path.startsWith(`${prefix}/`);
      });
  if (!served) {
    failures.push(
      `nginx location "${loc.path}" carries auth_request and proxies to "${loc.upstream}", which serves no route under it - the block decorates nothing`
    );
  }
}

// ── Report ───────────────────────────────────────────────────────────────────────────────────────

const guarded = [...allRoutes.values()].flat().filter((r) => r.authorized).length;
const total = [...allRoutes.values()].flat().length;

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} route(s) behind auth_request answer anybody:\n`);
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    `\n\`auth_request\` answers 200 for a logged-out caller, so it identifies and never refuses.` +
      `\nAdd the service's guard (NginxAuthGuard / HeaderAuthGuard), or declare the route in` +
      `\nPUBLIC_BY_INTENT with the reason it is meant to answer anybody.`
  );
  process.exit(1);
}

console.log(
  `OK: ${locations.length} auth_request locations, ${guarded}/${total} controller routes authorized, ` +
    `${matchedDeclarations.size} declared public by intent.`
);
