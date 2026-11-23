#!/usr/bin/env bun
/**
 * THE SERVICES THAT READ ZONE-LESS TIMESTAMPS RUN IN UTC BECAUSE WE SAY SO, NOT BECAUSE THE BASE IMAGE HAPPENS TO.
 *
 * The `submissions` dates are zone-less `timestamp` columns written on the UTC wall clock and read
 * back in the PROCESS's zone; the anonymous week cut and the XLSX date cells agree only while that
 * zone is UTC. The image and every compose file that runs social-service, core-service and chat-delivery-service
 * must pin `TZ=UTC` (the Postgres session zone is pinned in each service's `PG_SESSION_OPTIONS`).
 *
 * Usage: bun .github/scripts/tests/social-service-tz.test.mjs [repo-root]
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const failures = [];

const SERVICES = ['social-service', 'core-service', 'chat-delivery-service'];

for (const svc of SERVICES) {
  if (!/^ENV TZ=UTC$/m.test(read('infrastructure', 'local', `Dockerfile.${svc}`))) {
    failures.push(`Dockerfile.${svc} does not carry \`ENV TZ=UTC\``);
  }
}

for (const file of [
  ['infrastructure', 'docker-compose.prod.yml'],
  ['infrastructure', 'docker-compose.dev.yml'],
  ['infrastructure', 'local', 'docker-compose.yml'],
]) {
  const text = read(...file);
  for (const svc of SERVICES) {
    const start = text.indexOf(['', `  ${svc}:`, ''].join('\n'));
    if (start === -1) {
      failures.push(`${file.join('/')}: no ${svc} service`);
      continue;
    }
    const rest = text.slice(start + 1);
    const end = rest.slice(1).search(/^ {2}[a-zA-Z0-9_-]+:\s*$/m);
    const body = end === -1 ? rest : rest.slice(0, end + 1);
    if (!/^ {6}TZ: "?UTC"?\s*$/m.test(body)) {
      failures.push(`${file.join('/')}: ${svc} does not set \`TZ: UTC\``);
    }
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log(`social-service-tz: ${SERVICES.length} images and 3 compose files pin TZ=UTC`);
