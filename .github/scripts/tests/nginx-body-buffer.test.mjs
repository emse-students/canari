#!/usr/bin/env bun
/**
 * THE TWO ROUTES THAT CARRY MID-SIZED JSON BODIES KEEP THEM IN MEMORY (2026-11-13).
 *
 * nginx writes a request body above `client_body_buffer_size` (16k by default) to a temp file and
 * logs a warning each time: about 4300 a day on production, all from `/api/mls/` (commits,
 * Welcomes, KeyPackages) and `/api/channels`. Both take `128k`. The upload routes
 * (`/api/media`, `/api/posts`, ...) are left as they are on purpose: a large body there is
 * SUPPOSED to be spooled, and a bigger buffer would hold it per connection in memory.
 *
 * Static, like the other nginx shape tests: CI has no Docker daemon to run nginx in.
 *
 * Usage: bun .github/scripts/tests/nginx-body-buffer.test.mjs [repo-root]
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const lines = readFileSync(join(ROOT, 'infrastructure', 'local', 'Dockerfile.frontend'), 'utf8')
  .split('\n')
  .map((l) => l.replace(/\\n\\$/, '').trim());

/** The directives of `location <name> {` up to its closing brace, comments dropped. */
function block(name) {
  const start = lines.findIndex((l) => l === `location ${name} {`);
  if (start === -1) return null;
  const body = [];
  let depth = 1;
  for (const line of lines.slice(start + 1)) {
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth <= 0) break;
    if (!line.startsWith('#')) body.push(line);
  }
  return body;
}

const failures = [];
for (const name of ['/api/mls/', '/api/channels']) {
  const body = block(name);
  if (!body) failures.push(`location ${name} not found`);
  else if (!body.includes('client_body_buffer_size 128k;'))
    failures.push(`location ${name} must set client_body_buffer_size 128k`);
}
for (const name of ['/api/media', '/api/posts']) {
  const body = block(name);
  if (!body) failures.push(`location ${name} not found (the upload control is blind)`);
  else if (body.some((l) => l.startsWith('client_body_buffer_size')))
    failures.push(`location ${name} is an upload route: it must keep nginx's default buffer`);
}

if (failures.length > 0) {
  console.error(`nginx-body-buffer: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log('nginx-body-buffer: /api/mls/ and /api/channels keep a 128k body buffer');
