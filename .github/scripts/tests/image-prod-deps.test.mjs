#!/usr/bin/env bun
/**
 * A NESTJS SERVICE IMAGE SHIPS ITS PRODUCTION DEPENDENCIES ONLY.
 *
 * The builder stage installs devDependencies (it needs tsc and the Nest CLI), and copying ITS
 * `node_modules` into the runtime stage put jest, ts-jest and the rest on the image's disk, in its
 * size and in the image scan. Each of the four Dockerfiles now has a `prod-deps` stage running
 * `bun install --production --frozen-lockfile`, and the runtime stage copies `node_modules` from
 * THAT stage. This test keeps it so, and proves its own checks with fixtures it must reject.
 *
 * Run by `make test-ci-scripts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..');
const SERVICES = ['core', 'social', 'media', 'chat-delivery'];

/**
 * Splits a Dockerfile into stages: `{ name, instructions }`, line continuations joined and
 * comments dropped. The name is the `AS <name>` of the `FROM`, or `null` for the unnamed final stage.
 */
export function parseStages(text) {
  const lines = text
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const stages = [];
  for (const line of lines) {
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    if (from) stages.push({ name: from[1] ?? null, instructions: [] });
    else if (stages.length) stages.at(-1).instructions.push(line);
  }
  return stages;
}

/** Every violated rule of one Dockerfile, as messages; empty when it complies. */
export function violations(text) {
  const out = [];
  const stages = parseStages(text);
  const prod = stages.find((s) => s.name === 'prod-deps');
  if (!prod) return ['no prod-deps stage'];
  const installs = prod.instructions.filter((l) => /\bbun install\b/.test(l));
  if (!installs.some((l) => /--production\b/.test(l) && /--frozen-lockfile\b/.test(l))) {
    out.push('the prod-deps stage has no `bun install --production --frozen-lockfile`');
  }
  const final = stages.at(-1);
  const copies = final.instructions.filter((l) => /^COPY\s.*[\s/]node_modules\b/.test(l));
  if (copies.length !== 1) {
    out.push(`the final stage has ${copies.length} node_modules COPY lines, expected 1`);
  } else {
    const m = /^COPY\s+--from=(\S+)\s+(\S+)\s+\S+$/.exec(copies[0]);
    if (!m || m[1] !== 'prod-deps')
      out.push('the final node_modules is not copied --from=prod-deps');
    else if (!/\/node_modules\/?$/.test(m[2])) {
      out.push(`the final COPY source ${m[2]} is not the stage's node_modules`);
    }
  }
  return out;
}

let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

for (const s of SERVICES) {
  const file = `Dockerfile.${s}-service`;
  const text = readFileSync(join(ROOT, 'infrastructure', 'local', file), 'utf8');
  const bad = violations(text);
  check(
    bad.length === 0,
    `${file}: ${bad.length ? bad.join('; ') : 'ships production dependencies only'}`
  );
}

// Negative fixtures: the guard must refuse each of these.
const GOOD = `FROM oven/bun:1 AS builder
RUN cd app && bun install --frozen-lockfile
FROM oven/bun:1 AS prod-deps
RUN cd app && \\
    bun install --production \\
      --frozen-lockfile
FROM oven/bun:1
COPY --from=builder /app/dist ./dist
COPY --from=prod-deps /app/apps/x/node_modules ./node_modules
`;
check(violations(GOOD).length === 0, 'fixture: a compliant Dockerfile with continuations passes');
check(
  violations(
    GOOD.replace(
      'bun install --production \\\n      --frozen-lockfile',
      'bun install --frozen-lockfile'
    ).replace(
      'bun install --frozen-lockfile\nFROM oven/bun:1 AS prod-deps',
      'bun install --production --frozen-lockfile\nFROM oven/bun:1 AS prod-deps'
    )
  ).length > 0,
  'fixture: the flags only on the builder install are refused'
);
check(
  violations(GOOD.replace('--from=prod-deps', '--from=builder')).length > 0,
  'fixture: a node_modules COPY from builder is refused'
);
check(
  violations(GOOD.replace('/app/apps/x/node_modules', '/app/apps/x/dist')).length > 0,
  'fixture: a COPY from prod-deps whose source is not node_modules is refused'
);
check(
  violations(GOOD.replace('FROM oven/bun:1 AS prod-deps', 'FROM oven/bun:1 AS other')).length > 0,
  'fixture: a missing prod-deps stage is refused'
);

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall image prod-deps checks passed');
