#!/usr/bin/env bun
/**
 * A NESTJS SERVICE IMAGE SHIPS ITS PRODUCTION DEPENDENCIES ONLY.
 *
 * The builder stage installs devDependencies (it needs tsc and the Nest CLI), and copying ITS
 * `node_modules` into the runtime stage put jest, ts-jest and the rest on the image's disk, in its
 * size and in the image scan. Each of the four Dockerfiles now has a `prod-deps` stage running
 * `bun install --production --frozen-lockfile`, and the runtime stage copies `node_modules` from
 * THAT stage. This test keeps it so: a runtime copy from `builder` fails.
 *
 * Run by `make test-ci-scripts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..');
const SERVICES = ['core', 'social', 'media', 'chat-delivery'];

let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

for (const s of SERVICES) {
  const file = `Dockerfile.${s}-service`;
  const text = readFileSync(join(ROOT, 'infrastructure', 'local', file), 'utf8')
    .replace(/\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const stages = text.filter((l) => /^FROM\s/i.test(l));
  const prodStage = stages.findIndex((l) => /\sAS\s+prod-deps$/i.test(l));
  check(prodStage !== -1, `${file}: has a prod-deps stage`);
  const installs = text.filter((l) => /bun install/.test(l));
  check(
    installs.some((l) => /--production/.test(l) && /--frozen-lockfile/.test(l)),
    `${file}: prod-deps installs with --production --frozen-lockfile`
  );
  const nodeModulesCopies = text.filter((l) => /^COPY\s.*[\s/]node_modules\b/.test(l));
  check(
    nodeModulesCopies.length === 1 && /--from=prod-deps\b/.test(nodeModulesCopies[0]),
    `${file}: the runtime node_modules comes from prod-deps, never from builder`
  );
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall image prod-deps checks passed');
