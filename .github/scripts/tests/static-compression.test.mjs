#!/usr/bin/env bun
/**
 * THE FRONTEND ORIGIN COMPRESSES THE ASSETS A COLD START IS MADE OF.
 *
 * Measured on production 2026-10-09 (`curl` with `Accept-Encoding: br,gzip` against
 * canari.emse.fr, DNS straight to the host, no CDN): the 2 126 190-byte MLS WASM, the 239 701-byte
 * stylesheet and every JavaScript chunk answered with NO `Content-Encoding`, because the config
 * named `application/json` and nothing else. A cold start on Slow 3G is bytes divided by 50 kB/s,
 * so that omission was ~60 of the ~100 seconds.
 *
 * It is a static assertion for the reason `static-headers.test.mjs` is one: a probe proves one URL on
 * one estate at one moment, and this file is the whole description of what the origin sends.
 * It asserts the three things whose absence is silent: the content types that make a cold start,
 * `gzip_proxied any` (the host proxy adds `Via`, and nginx then skips compression with no log
 * line), and `gzip_vary` (one URL, two representations).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const text = readFileSync(join(ROOT, 'infrastructure', 'local', 'Dockerfile.frontend'), 'utf8');

const directives = text
  .split('\n')
  .map((l) => l.replace(/\\n\\$/, '').trim())
  .filter((l) => l && !l.startsWith('#'));
const value = (name) =>
  directives
    .find((l) => l.startsWith(`${name} `))
    ?.replace(/;$/, '')
    .slice(name.length + 1);

const failures = [];

if (value('gzip') !== 'on') failures.push('`gzip on;` is missing from the frontend server block.');
if (value('gzip_proxied') !== 'any') {
  failures.push(
    '`gzip_proxied any;` is missing: the host proxy sends `Via`, and without it nginx serves every ' +
      'asset uncompressed and says nothing.'
  );
}
if (value('gzip_vary') !== 'on') failures.push('`gzip_vary on;` is missing.');

const types = new Set((value('gzip_types') ?? '').split(/\s+/).filter(Boolean));
for (const t of [
  'application/javascript',
  'text/css',
  'application/wasm',
  'image/svg+xml',
  'application/json',
]) {
  if (!types.has(t)) {
    failures.push(`gzip_types does not list ${t}: that asset leaves the origin uncompressed.`);
  }
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} problem(s) in the frontend compression config:\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}
console.log(`OK: gzip on for ${types.size} content types, proxied requests included, Vary set.`);
