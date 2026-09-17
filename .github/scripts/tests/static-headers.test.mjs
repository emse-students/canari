#!/usr/bin/env bun
/**
 * EVERY NGINX BLOCK THAT ANSWERS A BROWSER SAYS HOW LONG THE ANSWER LIVES, AND CARRIES THE THREE
 * SECURITY HEADERS ITSELF.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION. The convention was already written, at the top of
 * `infrastructure/local/Dockerfile.frontend`, next to the CSP snippet it exists to protect:
 * `add_header` REPLACES the inherited set rather than adding to it, so a block that sets one header
 * of its own loses every server-level header unless it restates them. It was stated, and then it
 * was not applied - measured on production 2026-09-16, four blocks set a `Cache-Control` and
 * stopped there, so the emoji font, every content-hashed bundle, every `.mjs` worker and both App
 * Link manifests were served with no `X-Content-Type-Options` and no `X-Frame-Options`. An HTML
 * page had all three, because `@ssr` declared nothing and inherited correctly. The convention held
 * exactly where nobody had written a header.
 *
 * THE CACHE HALF COST FIFTEEN SECONDS OF START-UP. The same `location /` carried
 * `Cache-Control: no-store`, written for the HTML page - which never reaches it, because
 * `try_files $uri @ssr` hands a page to a named location and keeps only the files on disk. So the
 * directive missed its target and hit the 5 705 472-byte emoji font instead, on every single page
 * load, uncacheable by the browser and answered `cf-cache-status: BYPASS` by the edge. Preloaded
 * from `app.html`, it went first and held the origin link while the 723 kB MLS engine queued behind
 * it and took 13 286 ms of a fifteen-second cold start.
 *
 * Both halves are the same mistake - a header written in the block where it reads well rather than
 * the block that will send it - so one gate asserts both.
 *
 * IT IS DELIBERATELY STATIC. A probe proves one URL on one estate at one moment, and this file is
 * the only description of the edge there is: asserting it here proves the shape of every block, in
 * CI, before a deploy exists.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const NGINX = join(ROOT, 'infrastructure', 'local', 'Dockerfile.frontend');

/**
 * Blocks that answer a browser with a document or an asset, and must therefore be complete.
 *
 * The `/api/` proxies are out of scope on purpose and the reason is not "less important": their
 * responses are written by the upstream services, so what a header here does depends on what the
 * service already sent, and that is a different question from this one. Naming them as excluded is
 * the honest form - an unstated exclusion looks exactly like an omission, which is the defect this
 * file exists to catch.
 */
const BROWSER_FACING = new Set([
  '/.well-known/',
  '/_app/immutable/',
  '~* \\.mjs$',
  '/fonts/',
  '/',
  '@ssr',
  '@app_shell',
]);

/** The three the CSP comment at the top of the Dockerfile requires of any block that sets a header. */
const SECURITY = [
  { needle: 'snippets/csp.conf', name: 'the CSP include' },
  { needle: 'X-Content-Type-Options', name: 'X-Content-Type-Options' },
  { needle: 'X-Frame-Options', name: 'X-Frame-Options' },
];

/**
 * Parses the `location` blocks out of the Dockerfile's embedded nginx config.
 *
 * The config lives inside a single `RUN printf`, one directive per source line ending `\n\`, so a
 * line-oriented reader sees it exactly as nginx will. Brace depth is tracked rather than assumed:
 * `if` blocks nest inside a location and their directives belong to it.
 *
 * @param text the Dockerfile's contents.
 * @returns one entry per location, with its header text joined.
 */
function parseLocations(text) {
  const blocks = [];
  let current = null;
  let depth = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\\n\\$/, '').trim();
    const opened = line.match(/^location\s+(.+?)\s*\{$/);
    if (opened && current === null) {
      // The modifier is part of the name on purpose: `location = /` and `location /` are two
      // different blocks, the first a one-line redirect into @ssr that sends nothing, and folding
      // them together made this gate accuse the wrong one.
      current = { name: opened[1].trim(), lines: [] };
      depth = 1;
      continue;
    }
    if (current === null) continue;
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth <= 0) {
      blocks.push({ ...current, body: current.lines.join('\n') });
      current = null;
      continue;
    }
    if (!line.startsWith('#')) current.lines.push(line);
  }
  return blocks;
}

const text = readFileSync(NGINX, 'utf8');
const locations = parseLocations(text);
const failures = [];

const seen = new Set(locations.map((l) => l.name));
for (const name of BROWSER_FACING) {
  if (!seen.has(name)) {
    failures.push(
      `location ${name} is required to exist and does not - either it was renamed, in which case ` +
        `update BROWSER_FACING, or it was deleted and the paths it answered now fall elsewhere.`
    );
  }
}

for (const block of locations) {
  if (!BROWSER_FACING.has(block.name)) continue;

  if (!/add_header\s+Cache-Control/.test(block.body)) {
    failures.push(
      `location ${block.name} sends no Cache-Control. A browser then invents one from Last-Modified, ` +
        `and Cloudflare caches or refuses to cache on its own extension list - neither is a decision ` +
        `this file made.`
    );
  }

  const noStore = /add_header\s+Cache-Control\s+"no-store"/.test(block.body);
  const servesFiles = /try_files\s+\$uri/.test(block.body);
  if (noStore && servesFiles) {
    failures.push(
      `location ${block.name} stamps no-store on files served off disk. That is the 2026-09-16 ` +
        `defect exactly: the directive was meant for the page, the page reaches a named location, ` +
        `and the only thing left to receive it was a 5.7 MB font on every page load.`
    );
  }

  // A SHARED CACHE CAN BE PURGED AND A BROWSER CACHE CANNOT, so anything a deploy
  // invalidates may be offered to the edge and never to a disk. The SSR shell names
  // content-hashed chunks that the NEXT image does not contain, so a shell outliving its
  // build is a blank page - recoverable at the edge, where `serve-prod.yml` purges the
  // zone, and not recoverable at all in a browser that was told to keep it.
  const shared = block.body.match(/add_header\s+Cache-Control\s+"([^"]*s-maxage[^"]*)"/);
  if (shared && !/(^|[\s,])max-age=0([\s,]|$)/.test(shared[1])) {
    failures.push(
      `location ${block.name} offers a shared cache ${shared[1]} without max-age=0. A purge ` +
        `reaches Cloudflare and never a user's disk, so a browser TTL on something a deploy ` +
        `invalidates is a blank page nobody can fix.`
    );
  }

  // THE DEGRADED PAGE IS THE ONE ANSWER THAT MUST NEVER OUTLIVE ITS CAUSE. @app_shell is
  // served when frontend-ssr is down, and nginx answers it 200 so Cloudflare does not
  // replace the body. A 200 is cacheable, so any TTL here would pin the whole site in
  // degraded mode for that long AFTER the outage ended - the site would look broken
  // because it once was.
  if (/add_header\s+X-Canari-Degraded/.test(block.body) && !noStore) {
    failures.push(
      `location ${block.name} announces X-Canari-Degraded without no-store. It answers 200 so ` +
        `a cache will keep it, and the site would stay degraded for the TTL after the outage ` +
        `that caused it was over.`
    );
  }

  for (const { needle, name } of SECURITY) {
    if (!block.body.includes(needle)) {
      failures.push(
        `location ${block.name} sets headers of its own but does not restate ${name}. nginx drops ` +
          `the whole inherited add_header set from such a block, so this one is not sent at all.`
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} problem(s) in the browser-facing nginx blocks:\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

console.log(
  `OK: ${BROWSER_FACING.size} browser-facing location(s), each with a Cache-Control it chose and ` +
    `all three security headers restated.`
);
