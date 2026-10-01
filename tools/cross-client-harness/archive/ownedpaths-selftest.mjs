/**
 * Pins `ownedpaths.mjs`: a 404 outside the application's route/static set is a scanner's guess, a 404
 * inside it is a defect that must stay in the gate - checked on a fixture tree AND the real one.
 *
 * No estate and no `names.mjs`: `srvReport` is driven with an injected reader.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isForeign404, makeOwnedPaths, ownedPaths } from '../ownedpaths.mjs';
import { srvReport } from '../srvlog.mjs';

let failures = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
};

// --- a fixture tree: groups, params, rest, a static dir and a static file -----------------------
const root = mkdtempSync(join(tmpdir(), 'owned-'));
const touch = (rel) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '');
};
touch('routes/+page.svelte');
touch('routes/chat/+page.svelte');
touch('routes/(app)/dashboard/+page.svelte');
touch('routes/profile/[id]/+page.svelte');
touch('routes/docs/[...rest]/+page.svelte');
touch('routes/robots.txt/+server.ts');
touch('static/favicon.ico');
touch('static/emoji/a.svg');
const owned = makeOwnedPaths({ routesDir: join(root, 'routes'), staticDir: join(root, 'static') });

for (const p of ['/', '/chat', '/chat/zzz', '/dashboard', '/profile/abc', '/docs/a/b', '/robots.txt', '/favicon.ico', '/emoji/x.svg', '/api/v1/version', '/.well-known/x', '/_app/immutable/a.js']) {
  check(`owned ${p}`, owned(p), true);
}
for (const p of ['/WP', '/old', '/Old', '/wp-login.php', '/Chat', '/profile', '/administrator/', '/.env']) {
  check(`foreign ${p}`, owned(p), false);
}
check('a query string does not make a foreign path owned', owned('/old?x=chat'), false);

check('a 404 on a scanner path is foreign', isForeign404('[404] HEAD /WP', owned), true);
check('a 404 on an owned path is NOT foreign', isForeign404('[404] GET /chat', owned), false);
check('a 200 is never classified here', isForeign404('[200] GET /old', owned), false);
check('a non-request line is untouched', isForeign404('something else', owned), false);

// --- the real tree: the three lines that stopped a --repeat, and a route we do own ---------------
const real = ownedPaths();
for (const p of ['/WP', '/old', '/Old']) check(`real tree: ${p} foreign`, real(p), false);
for (const p of ['/chat', '/login', '/robots.txt', '/sitemap.xml', '/favicon.ico']) check(`real tree: ${p} owned`, real(p), true);

// --- srvReport: the scanner is notable, an owned 404 still breaks `clean` ------------------------
const report = (lines) => srvReport(() => lines, '1m')['frontend-ssr'];
const scan = report(['[404] HEAD /WP', '[404] HEAD /old', '[404] HEAD /Old']);
check('three scanner 404s leave the window clean', scan.clean, true);
check('and stay visible as notable', scan.notableCount, 3);
const ours = report(['[404] GET /chat', '[404] HEAD /old']);
check('an owned-path 404 still gates', ours.clean, false);
check('only the owned one is unexplained', ours.unexplained, ['[404] GET /chat']);

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log('ownedpaths-selftest OK');
