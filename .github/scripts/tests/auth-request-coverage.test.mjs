#!/usr/bin/env bun
/**
 * `auth_request` IDENTIFIES A CALLER. IT REFUSES NOBODY. THIS IS THE GATE THAT SAYS SO.
 *
 * Fifteen `location` blocks in `infrastructure/local/Dockerfile.frontend` carry
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
 *
 * **IT COVERS THE RUST CRATES SINCE 2026-09-17, AND UNTIL THAT DAY IT DID NOT COVER `/api/presence`
 * - THE ROUTE IT WAS WRITTEN FOR.** Three of the fifteen locations proxy to `chat-gateway` and one
 * to `call-service`, Axum crates with no controller layer at all, and the authorization loop below
 * skipped every upstream it could not find a NestJS directory for. Worse, `call-service` was
 * DECLARED a NestJS service: `nestRoutes` walked the crate, found no `*.controller.ts`, returned an
 * empty list, and the location read as covered while being held against nothing. Four routes -
 * `/api/ws`, `/api/presence`, `/api/admin/presence` and the call socket - all four authorized, none
 * of them asserted. The next Axum route added would have been the next `/api/presence`, which is
 * the one thing this file exists to make impossible.
 *
 * So the Rust half is read from the router the crate actually builds, and **a declared service that
 * yields NO routes fails by name**. A coverage map is only coverage if every entry is doing work;
 * an entry that has quietly stopped matching anything reads exactly like one that still does.
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
    route: 'GET /payments/provider',
    why: "global platform config ('stripe' | 'lydia'), never user-specific; social-service's resolvePaymentTarget (every checkout/purchase/delegation path) calls it directly over the Docker network, which never goes through nginx and so can never carry an x-user-id - a guard here 401ed all of them (2026-09-14)",
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

/**
 * The four values the sub-request answers with, and the header each is forwarded as.
 *
 * THIS IS THE PRECONDITION FOR ONE SHARED GUARD, AND IT IS WHY THERE ARE STILL THREE.
 * `NginxAuthGuard` (core-service, social-service) refuses on an empty `x-user-id`;
 * `HeaderAuthGuard` (chat-delivery-service) refuses on `x-user-logged-in !== 'true'`. Two
 * discriminators for one rule, and they agree only because every `auth_request` location copies the
 * SAME four values out of the sub-request and forwards all four. A location that set `$user_id` and
 * forgot `X-User-Logged-In` would pass every core-service route and refuse every chat-delivery one,
 * with nothing in either service able to say why - and `X-Internal-Token` missing is a service with
 * `INTERNAL_SHARED_SECRET` set refusing everybody, which reads as an outage rather than as a config.
 *
 * All fifteen locations are uniform (measured 2026-09-17), which is exactly when to write it down:
 * an invariant asserted while it holds costs one list, and asserted after it breaks costs a day.
 */
const IDENTITY = [
  ['$user_id', 'X-User-Id'],
  ['$user_logged_in', 'X-User-Logged-In'],
  ['$global_admin', 'X-Global-Admin'],
  ['$internal_token', 'X-Internal-Token'],
];

/** The nginx locations carrying `auth_request`, the upstream each proxies to, and what each
 *  forwards of the caller's identity. */
function authRequestLocations() {
  const raw = readFileSync(NGINX, 'utf8');
  // The file is a Dockerfile heredoc: every config line ends with a literal `\n\`.
  const lines = raw.split('\n').map((l) => l.replace(/\\n\\\s*$/, '').trimEnd());
  const out = [];
  let current = null;
  for (const line of lines) {
    const loc = line.match(/^\s*location\s+(?:=\s+)?(\/\S*)\s*\{/);
    if (loc) {
      current = {
        path: loc[1],
        authRequest: false,
        upstream: null,
        rewriteTo: null,
        sets: new Set(),
        forwards: new Set(),
      };
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
    const set = line.match(/^\s*auth_request_set\s+(\$\w+)\s/);
    if (set) current.sets.add(set[1]);
    const fwd = line.match(/^\s*proxy_set_header\s+(X-[A-Za-z-]+)\s/);
    if (fwd) current.forwards.add(fwd[1]);
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

// -- The Rust crates ----------------------------------------------------------------------------

/**
 * In-handler authorization idioms on the Rust side.
 *
 * There is no guard LAYER on either Axum router - no `.layer(...)` anywhere that could refuse a
 * caller - so authorization is a call the handler makes itself, and the only honest way to assert
 * it is to name those calls. The Nest half has the same list for the same reason (`IN_BODY_AUTH`),
 * and neither is a list of route names: it is a list of ways to say no.
 */
const RUST_AUTH = [
  // `presence.rs` - nginx's `x-user-id` arrives EMPTY for a caller the auth sub-request did not
  // recognise, so a blank value is what an anonymous caller looks like.
  'is_authenticated',
  // `get_admin_presence` - the same header contract, one claim further along.
  'x-global-admin',
  // Both WebSocket upgrades - the `canari_ws_token` JWT, which nginx never reads and `auth_request`
  // therefore cannot have checked.
  'decode::<Claims>',
];

/**
 * A Rust source twice over: comments blanked, and comments AND string interiors blanked.
 *
 * Both copies are the SAME LENGTH as the input, so an index found in one addresses the other.
 * `skeleton` is what braces and parentheses are counted in - `format!("{}:{}", ..)` closes a
 * handler body eight lines early otherwise - and `codeOnly` is what idioms are matched in, because
 * one of the idioms IS a string literal (`"x-global-admin"`).
 *
 * NEITHER MAY BE MATCHED IN A COMMENT, which is the same trap as `isCommentLine` above one language
 * over: the docblock on `get_presence` says "REQUIRES AN AUTHENTICATED CALLER" in prose, and a
 * handler credited by its own comment is a handler nothing has checked.
 */
function maskRust(src) {
  const code = src.split('');
  const skel = src.split('');
  const hide = (arr, from, to) => {
    for (let k = from; k < to; k++) if (arr[k] !== '\n') arr[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? src.length : nl;
      hide(code, i, end);
      hide(skel, i, end);
      i = end;
    } else if (two === '/*') {
      // Rust block comments NEST, so a `/*` inside one is not the end of anything.
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src.slice(j, j + 2) === '/*') {
          depth++;
          j += 2;
        } else if (src.slice(j, j + 2) === '*/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      hide(code, i, j);
      hide(skel, i, j);
      i = j;
    } else if (/^r#*"/.test(src.slice(i, i + 12)) && !/[A-Za-z0-9_]/.test(src[i - 1] ?? ' ')) {
      const hashes = /^r(#*)"/.exec(src.slice(i, i + 12))[1];
      const close = `"${hashes}`;
      const at = src.indexOf(close, i + hashes.length + 2);
      const end = at < 0 ? src.length : at + close.length;
      hide(skel, i, end);
      i = end;
    } else if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      hide(skel, i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return { codeOnly: code.join(''), skeleton: skel.join('') };
}

/** `[start, end)` of the balanced run beginning at the opening delimiter at `from`, or `null`. */
function balanced(skeleton, from, open, close) {
  let depth = 0;
  for (let i = from; i < skeleton.length; i++) {
    if (skeleton[i] === open) depth++;
    else if (skeleton[i] === close && --depth === 0) return [from, i + 1];
  }
  return null;
}

/**
 * `[start, end)` of a crate's `#[cfg(test)]` module, or `null`.
 *
 * THE TEST MODULE IS NOT THE ROUTER. `chat-gateway/src/main.rs` builds a second, minimal router
 * inside it carrying `/api/presence` with a closure answering `"ok"` - a CORS fixture, and the only
 * `.route(` in this repository with no handler function behind it. Read as production routing it is
 * a phantom that no service serves, reported either as an unguarded route or as a handler that
 * cannot be found; both accusations are false, and a gate that cries wolf is one nobody reads.
 */
function testModuleSpan(skeleton) {
  const at = skeleton.indexOf('#[cfg(test)]');
  if (at < 0) return null;
  const open = skeleton.indexOf('{', at);
  if (open < 0) return null;
  return [at, (balanced(skeleton, open, '{', '}') ?? [0, skeleton.length])[1]];
}

/** Every `.rs` file in a crate. */
function rustFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...rustFiles(p));
    else if (name.endsWith('.rs')) out.push(p);
  }
  return out;
}

/**
 * Every route an Axum router registers, as `{ route, handler }` - `route` spelt `VERB /path`,
 * exactly as `PUBLIC_BY_INTENT` spells a Nest one.
 *
 * The path is the one the CRATE registers, never the one nginx publishes: `call-service` serves
 * `/ws` and the edge rewrites `/api/call(.*)` onto it, so the location's own `rewrite` is what
 * relates the two. A route table renamed to match the edge would be answering from the wrong end.
 *
 * A `.route(` whose handler this cannot read yields `{ handler: null }` rather than nothing, so an
 * unparseable router FAILS instead of quietly shrinking the set being asserted.
 */
function axumRoutes(crateDir) {
  const { codeOnly, skeleton } = maskRust(readFileSync(join(crateDir, 'main.rs'), 'utf8'));
  const tests = testModuleSpan(skeleton);
  const out = [];
  for (const m of skeleton.matchAll(/\.route\(/g)) {
    if (tests && m.index >= tests[0] && m.index < tests[1]) continue;
    const span = balanced(skeleton, m.index + '.route'.length, '(', ')');
    if (!span) continue;
    const args = codeOnly.slice(span[0], span[1]);
    const path = args.match(/^\(\s*"([^"]+)"/)?.[1];
    if (!path) continue;
    const calls = [
      ...args.matchAll(/\b(get|post|put|patch|delete|head|options|any)\s*\(\s*([A-Za-z_]\w*)/g),
    ];
    if (calls.length === 0) out.push({ route: `? ${path}`, handler: null });
    for (const c of calls) out.push({ route: `${c[1].toUpperCase()} ${path}`, handler: c[2] });
  }
  return out;
}

/** The body of a Rust function with its comments blanked, or `null` if the crate declares none. */
function rustFnBody(crateDir, name) {
  for (const file of rustFiles(crateDir)) {
    const { codeOnly, skeleton } = maskRust(readFileSync(file, 'utf8'));
    const sig = new RegExp(`\\bfn\\s+${name}\\s*\\(`).exec(skeleton);
    if (!sig) continue;
    const open = skeleton.indexOf('{', sig.index);
    const span = open < 0 ? null : balanced(skeleton, open, '{', '}');
    if (span) return codeOnly.slice(span[0], span[1]);
  }
  return null;
}

// ── The assertions ───────────────────────────────────────────────────────────────────────────────

const failures = [];
const locations = authRequestLocations();

if (locations.length < 10) {
  failures.push(
    `parsed only ${locations.length} auth_request locations from ${NGINX} - the parser and the config disagree, which is a failure of this gate rather than a pass`
  );
}

/** NestJS services, and the `/api` prefix nginx strips before proxying. */
const NEST = {
  'chat-delivery-service': join(REPO, 'apps', 'chat-delivery-service', 'src'),
  'core-service': join(REPO, 'apps', 'core-service', 'src'),
  'media-service': join(REPO, 'apps', 'media-service', 'src'),
  'social-service': join(REPO, 'apps', 'social-service', 'src'),
};

/** The Axum crates. `call-service` was in the map above until 2026-09-17 and has no controller. */
const RUST = {
  'chat-gateway': join(REPO, 'apps', 'chat-gateway', 'src'),
  'call-service': join(REPO, 'apps', 'call-service', 'src'),
};

const allRoutes = new Map();
for (const [service, dir] of Object.entries(NEST)) {
  for (const r of nestRoutes(dir)) {
    if (!allRoutes.has(r.route)) allRoutes.set(r.route, []);
    allRoutes.get(r.route).push({ ...r, service });
  }
}

const rustRoutes = new Map(Object.entries(RUST).map(([s, dir]) => [s, axumRoutes(dir)]));

// A DECLARED SERVICE THAT YIELDS NO ROUTES IS NOT A COVERED SERVICE, and it reads as one. See the
// head of this file: `call-service` sat in NEST for six days contributing an empty list, so
// `/api/call` was held against nothing at all. Same assertion `serverProse.test.ts` makes about
// every tree it claims to walk, for the same reason - a floor on the TOTAL cannot see it.
const perService = (s) => [...allRoutes.values()].flat().filter((h) => h.service === s).length;
for (const service of Object.keys(NEST)) {
  if (perService(service) === 0) {
    failures.push(
      `NEST declares "${service}" and no *.controller.ts under it yielded a route - either it is not a NestJS service (move it to RUST) or the scan is broken; an empty list is not coverage`
    );
  }
}
for (const [service, routes] of rustRoutes) {
  if (routes.length === 0) {
    failures.push(
      `RUST declares "${service}" and its main.rs registered no route - either the router moved out of main.rs or the parser is broken; an empty list is not coverage`
    );
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

// THE RUST HALF. Axum has no guard layer here, so the handler's own body is the whole of the
// enforcement - and `/api/presence`, the route that opened this file, lives on this side.
let rustChecked = 0;
let rustAuthorized = 0;
for (const loc of locations) {
  const dir = RUST[loc.upstream];
  if (!dir) continue;
  // What the upstream is ASKED for is not the location path: `/api/call(.*)` arrives as `/ws$1`.
  const prefix = (loc.rewriteTo ?? loc.path).replace(/\/$/, '');
  for (const r of rustRoutes.get(loc.upstream)) {
    const path = r.route.split(' ')[1];
    if (!(path === prefix || path.startsWith(`${prefix}/`))) continue;
    rustChecked++;
    if (r.handler === null) {
      failures.push(
        `${loc.upstream} registers "${path}" behind nginx location "${loc.path}" with a handler this gate cannot read - name the function instead of inlining a closure, so its authorization can be asserted`
      );
      continue;
    }
    const body = rustFnBody(dir, r.handler);
    if (body === null) {
      failures.push(
        `${loc.upstream} routes "${path}" to \`${r.handler}\`, which no .rs file in apps/${loc.upstream}/src declares - the parser and the crate disagree, which is a failure of this gate rather than a pass`
      );
      continue;
    }
    if (RUST_AUTH.some((idiom) => body.includes(idiom))) {
      rustAuthorized++;
      continue;
    }
    if (declared.has(r.route)) {
      matchedDeclarations.add(r.route);
      continue;
    }
    failures.push(
      `${r.route} sits behind nginx location "${loc.path}" (auth_request) with NO authorization and NO declaration - apps/${loc.upstream}/src, fn ${r.handler}`
    );
  }
}

const everyKnownRoute = new Set([
  ...allRoutes.keys(),
  ...[...rustRoutes.values()].flat().map((r) => r.route),
]);

// EVERY DECLARATION MUST STILL BE DOING WORK, and "the route still exists" is not that test.
// Checking existence alone let three entries survive the day their routes were guarded: the loop
// above skips an authorized route before it ever consults the list, so a declaration that has
// become unnecessary is simply never read. A reason nobody needs reads exactly like a reason
// somebody does, which is how a list of deliberate exceptions turns into a list of stale ones.
for (const entry of PUBLIC_BY_INTENT) {
  if (matchedDeclarations.has(entry.route)) continue;
  failures.push(
    !everyKnownRoute.has(entry.route)
      ? `PUBLIC_BY_INTENT names "${entry.route}", which no controller declares any more - delete the entry rather than leaving a reason for a route nobody serves`
      : `PUBLIC_BY_INTENT names "${entry.route}", which is now authorized or sits behind no auth_request location - the declaration buys nothing and must be deleted`
  );
}

// A CLIENT MAY SEND ANY HEADER IT LIKES, SO EVERY IDENTITY NAME IS EMPTIED AT SERVER LEVEL.
// nginx forwards a request header nobody overrode, and it inherits a `proxy_set_header` set only
// into a location that declares NONE of its own - so the server-level block is the net for a
// location that forgets to declare its own, which is the easy mistake and the one nobody notices.
// It must use the APP-FACING spelling: `auth_request_set` reads `X-Logged-In` off the sub-request
// and forwards it as `X-User-Logged-In`, and clearing the former protects nothing. Measured
// 2026-09-17: two of the four names were covered, and no location inherited, so the gap was inert -
// which is the only reason it was a latent trap rather than a bypass.
{
  const conf = readFileSync(NGINX, 'utf8');
  const serverLevel = conf.slice(0, conf.search(/^\s*location\s/m));
  for (const [, header] of IDENTITY) {
    const cleared = new RegExp(
      `proxy_set_header\\s+${header}\\s+"(?:|false)"`,
      'i'
    ).test(serverLevel);
    if (!cleared) {
      failures.push(
        `the server-level block never clears ${header}, so a location that declares no ` +
          `proxy_set_header of its own forwards whatever the CLIENT sent under that name`
      );
    }
  }
}

// THE IDENTITY A SERVICE RECEIVES MUST NOT DEPEND ON WHICH LOCATION IT CAME THROUGH. See IDENTITY
// above: three guards read two different discriminators out of these headers, and they can only be
// collapsed into one once nothing may set half of them.
for (const loc of locations) {
  for (const [variable, header] of IDENTITY) {
    if (!loc.sets.has(variable)) {
      failures.push(
        `nginx location "${loc.path}" carries auth_request and never does \`auth_request_set ${variable}\` - the upstream is handed half an identity, and which half decides whether it refuses`
      );
    } else if (!loc.forwards.has(header)) {
      failures.push(
        `nginx location "${loc.path}" sets ${variable} from the sub-request and never forwards it as ${header} - a value read and dropped is the same as one never read`
      );
    }
  }
}

// An `auth_request` location whose upstream serves nothing under it guards nothing, and reads in
// the config as though it does. `/api/groups` was exactly that until 2026-09-10.
for (const loc of locations) {
  const prefix = (loc.rewriteTo ?? loc.path).replace(/\/$/, '');
  const served = rustRoutes.has(loc.upstream)
    ? rustRoutes.get(loc.upstream).some((r) => {
        const path = r.route.split(' ')[1];
        return path === prefix || path.startsWith(`${prefix}/`);
      })
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
  console.error(
    `FAIL: ${failures.length} problem(s) - a route behind auth_request answers anybody, or this gate cannot see whether one does:\n`
  );
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
    `${rustAuthorized}/${rustChecked} Axum routes behind one authorized, ` +
    `${matchedDeclarations.size} declared public by intent.`
);
