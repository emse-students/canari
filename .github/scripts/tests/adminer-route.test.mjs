#!/usr/bin/env bun
/**
 * THE `/adminer/` ROUTE IS A DOOR ONTO THE DATABASE, SO ITS SHAPE IS ASSERTED, NOT DESCRIBED
 * (user, 2026-10-02: *"add an adminer route to canari, in a safe way"*).
 *
 * Every line below was either a decision or a defect found by RUNNING the config against fake
 * upstreams, and none of it can be read off a diff:
 *
 * - **THE GATE IS NOT `/internal/auth/verify`.** That sub-request answers 200 to a signed-out caller
 *   (it decorates, the service refuses - see `auth-request-coverage.test.mjs`), and nginx reads any 2xx
 *   as permission. Pointed at it, `/adminer/` would be open to the internet. The route's own
 *   sub-request answers 401 unless the cookie is a live session of a global admin.
 * - **EVERY REFUSAL IS A BARE 404**, so a visitor cannot tell the route exists.
 * - **`set` BEFORE `rewrite ... break`.** `break` ends the rewrite phase, so a `set` written after it
 *   never runs and proxy_pass is handed an empty host: a 500 on every request, found only by sending one.
 * - **ONLY GET, HEAD AND POST** reach the upstream.
 * - **THE FOUR IDENTITY HEADERS ARE CLEARED** on the way to Adminer: nothing it receives may name a user.
 * - **THE PAGE IS NEVER CACHED, NEVER FRAMED, NEVER INDEXED**, and its CSP names no third-party host
 *   (the site-wide one allows Klipy, which a database console has no business loading).
 * - **IT EXISTS WHERE IT IS ENABLED AND NOWHERE ELSE**: `ADMINER_ENABLED` is "true" in production's
 *   compose and an explicit "false" in the dev and local ones.
 *
 * IT IS DELIBERATELY STATIC - CI has no Docker daemon to run nginx in - so what it proves is the shape
 * of the config, and the behaviour was run by hand against the real image on 2026-10-02.
 *
 * Usage: bun .github/scripts/tests/adminer-route.test.mjs [repo-root]
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

const nginx = read('infrastructure', 'local', 'Dockerfile.frontend');
const failures = [];
const fail = (msg) => failures.push(msg);

/** The body of `location <name> {` up to its closing brace, one directive per line, comments dropped. */
function block(name) {
  const lines = nginx.split('\n').map((l) => l.replace(/\\n\\$/, '').trim());
  const start = lines.findIndex((l) => l === `location ${name} {`);
  if (start === -1) return null;
  const body = [];
  let depth = 1;
  for (const line of lines.slice(start + 1)) {
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth <= 0) break;
    if (!line.startsWith('#')) body.push(line);
  }
  return body.join('\n');
}

const gate = block('/adminer/');
const internal = block('= /internal/auth/adminer');
const hidden = block('@adminer_hidden');

if (gate === null) fail('location /adminer/ does not exist');
if (internal === null) fail('location = /internal/auth/adminer does not exist');
if (hidden === null) fail('location @adminer_hidden does not exist');

if (gate !== null) {
  if (/auth_request\s+\/internal\/auth\/verify/.test(gate)) {
    fail(
      '/adminer/ uses /internal/auth/verify, which answers 200 to a signed-out caller - the route would ' +
        'be open to anybody. It must use /internal/auth/adminer.'
    );
  }
  if (!/^auth_request\s+\/internal\/auth\/adminer;$/m.test(gate)) {
    fail('/adminer/ does not carry `auth_request /internal/auth/adminer`');
  }
  if (!/^error_page\s+401\s+403\s+=404\s+@adminer_hidden;$/m.test(gate)) {
    fail('/adminer/ does not turn a 401 and a 403 into the bare 404 of @adminer_hidden');
  }
  if (!/^limit_except\s+GET\s+HEAD\s+POST\s*\{\s*deny all;\s*\}$/m.test(gate)) {
    fail('/adminer/ does not restrict methods to GET, HEAD and POST');
  }

  const set = gate.search(/^set\s+\$upstream_adminer\s/m);
  const rewrite = gate.search(/^rewrite\s+\^\/adminer\/\(\.\*\)\$\s+\/\$1\s+break;$/m);
  if (set === -1 || rewrite === -1) {
    fail('/adminer/ must `set $upstream_adminer` and strip its prefix with `rewrite ... break`');
  } else if (set > rewrite) {
    fail(
      '`set $upstream_adminer` comes AFTER `rewrite ... break`: break ends the rewrite phase, the set ' +
        'never runs, and proxy_pass gets an empty host (a 500 on every request).'
    );
  }
  if (!/^proxy_pass\s+http:\/\/\$upstream_adminer;$/m.test(gate)) {
    fail('/adminer/ must proxy_pass to $upstream_adminer');
  }

  for (const header of ['X-User-Id', 'X-User-Logged-In', 'X-Global-Admin', 'X-Internal-Token']) {
    if (!new RegExp(`^proxy_set_header\\s+${header}\\s+"(false)?";$`, 'm').test(gate)) {
      fail(`/adminer/ does not clear ${header} on the way to Adminer`);
    }
  }
  if (!/^proxy_set_header\s+Cookie\s+\$adminer_cookie;$/m.test(gate)) {
    fail('/adminer/ must forward $adminer_cookie (the cookies with our own session stripped)');
  }

  const must = [
    [/add_header\s+Cache-Control\s+"no-store"\s+always;/, 'Cache-Control: no-store'],
    [/add_header\s+X-Content-Type-Options\s+"nosniff"\s+always;/, 'X-Content-Type-Options'],
    [/add_header\s+X-Frame-Options\s+"DENY"\s+always;/, 'X-Frame-Options: DENY'],
    [/add_header\s+X-Robots-Tag\s+"noindex, nofollow"\s+always;/, 'X-Robots-Tag'],
    [/add_header\s+Referrer-Policy\s+"no-referrer"\s+always;/, 'Referrer-Policy: no-referrer'],
    [/add_header\s+Content-Security-Policy\s/, 'its own Content-Security-Policy'],
  ];
  for (const [re, name] of must) if (!re.test(gate)) fail(`/adminer/ sends no ${name}`);

  // The config is written through `printf` in a shell, where a quote is spelled `'"'"'`: read it as nginx will.
  const csp = gate.replaceAll(`'"'"'`, "'").match(/add_header\s+Content-Security-Policy\s+"([^"]*)"/)?.[1] ?? '';
  if (!csp) fail('the /adminer/ CSP could not be read');
  if (/https?:\/\//.test(csp)) {
    fail(`the /adminer/ CSP names a third-party host (${csp.match(/https?:\/\/\S+/)?.[0]})`);
  }
  if (!csp.includes("default-src 'self'")) fail("the /adminer/ CSP does not start from default-src 'self'");
  if (!csp.includes("frame-ancestors 'none'")) fail("the /adminer/ CSP does not say frame-ancestors 'none'");
  if (/snippets\/csp\.conf/.test(gate)) {
    fail('/adminer/ includes the site-wide CSP, which allows Klipy - it needs its own');
  }
}

if (internal !== null) {
  if (!/^internal;$/m.test(internal)) fail('/internal/auth/adminer is not `internal`');
  if (!/proxy_pass\s+http:\/\/\$target_core_service\/api\/auth\/adminer-verify;/.test(internal)) {
    fail('/internal/auth/adminer must proxy to /api/auth/adminer-verify');
  }
  if (!/^proxy_set_header\s+Cookie\s+\$http_cookie;$/m.test(internal)) {
    fail('/internal/auth/adminer does not pass the Cookie header, which is all it reads');
  }
}

if (hidden !== null && !/^return\s+404;$/m.test(hidden)) {
  fail('@adminer_hidden must answer a bare 404');
}

// The cookie-stripping map, declared once before the server block.
if (!/map\s+\$http_cookie\s+\$adminer_cookie\s*\{/.test(nginx)) {
  fail('the `map $http_cookie $adminer_cookie` that strips our own session cookie is missing');
}

// WHERE THE ROUTE EXISTS: production only, and elsewhere an explicit false.
const flag = (file) =>
  read(...file).match(/^\s*ADMINER_ENABLED:\s*"?(\w+)"?\s*$/m)?.[1] ?? null;
const prod = flag(['infrastructure', 'docker-compose.prod.yml']);
if (prod !== 'true') fail(`production's compose sets ADMINER_ENABLED to ${prod}, expected "true"`);
for (const file of [
  ['infrastructure', 'docker-compose.dev.yml'],
  ['infrastructure', 'local', 'docker-compose.yml'],
]) {
  const value = flag(file);
  if (value !== 'false') {
    fail(`${file.join('/')} sets ADMINER_ENABLED to ${value}; it must be an explicit "false"`);
  }
}

// The adminer container itself publishes loopback only: the public path is the gated route.
const prodCompose = read('infrastructure', 'docker-compose.prod.yml');
const adminerService = prodCompose.match(/^ {2}adminer:\n([\s\S]*?)(?=^ {2}\S)/m)?.[1] ?? '';
const ports = [...adminerService.matchAll(/^\s*-\s*"([^"]+:\d+:\d+)"\s*$/gm)].map((m) => m[1]);
for (const port of ports) {
  if (!port.startsWith('127.0.0.1:')) fail(`the adminer container publishes ${port}, not loopback`);
}
if (!adminerService) fail('the adminer service was not found in the production compose');

// THE IMAGE IS UPSTREAM'S, WITH `libpq` UPGRADED, BUILT BY THE RELEASE (owner, 2026-11-13): the scan reads
// the built image, so production must run exactly that one. Temporary - docs/wiki/legacy-compatibility.md.
const ownImage = /^\s*image:\s*\$\{REGISTRY:-ghcr\.io\}\/\$\{IMAGE_PREFIX:-emse-students\/canari\}\/adminer:\$\{TAG:-latest\}\s*$/m;
if (!ownImage.test(adminerService)) {
  fail('production does not run the adminer image this repository builds (ghcr .../canari/adminer:${TAG})');
}
if (!/^\s*dockerfile:\s*infrastructure\/local\/Dockerfile\.adminer\s*$/m.test(adminerService)) {
  fail('the production adminer service is not built from infrastructure/local/Dockerfile.adminer');
}
if (!/^\s*canari\.deploy\.replace:\s*exclusive\s*$/m.test(adminerService)) {
  fail('an image built here is replaced by every release: the adminer service must declare `exclusive`');
}
if (!/^\s*-\s*\.\/adminer\/php-hardening\.ini:\/usr\/local\/etc\/php\/conf\.d\/zz-hardening\.ini:ro\s*$/m.test(adminerService)) {
  fail('the adminer service no longer mounts php-hardening.ini read-only');
}
const adminerDockerfile = read('infrastructure', 'local', 'Dockerfile.adminer')
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.trim().startsWith('#'));
const from = adminerDockerfile.filter((l) => /^FROM\s/i.test(l));
if (from.length !== 1 || !/^FROM\s+adminer:[\w.-]+@sha256:[0-9a-f]{64}$/.test(from[0])) {
  fail(`Dockerfile.adminer must have ONE stage, FROM upstream adminer pinned by tag and digest (got ${from.join(' | ')})`);
}
const runs = adminerDockerfile.filter((l) => /^RUN\s/i.test(l));
if (runs.length !== 1 || runs[0] !== "RUN apk upgrade --no-cache libpq && apk info -e 'libpq>=18.7-r0'") {
  fail(`Dockerfile.adminer may only upgrade libpq (got ${runs.join(' | ')})`);
}
if (adminerDockerfile.at(-1) !== 'USER adminer') {
  fail('Dockerfile.adminer must end as the user the upstream image runs as, `USER adminer`');
}
if (!/\[adminer\]="\.\/infrastructure\/local\/Dockerfile\.adminer"/.test(read('.github', 'workflows', 'build.yml'))) {
  fail('build.yml does not build Dockerfile.adminer, so no release pushes the image production runs');
}
// A cached `apk upgrade` layer could carry an old libpq while the scan builds fresh (review of #3442).
if (!/^\s*no-cache:\s*\$\{\{\s*matrix\.name == 'adminer'\s*\}\}\s*$/m.test(read('.github', 'workflows', 'build.yml'))) {
  fail("build.yml may build adminer from its cache - `no-cache: ${{ matrix.name == 'adminer' }}` is missing");
}

if (failures.length > 0) {
  console.error(`adminer-route: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log('adminer-route: the /adminer/ route has the shape it must have');
