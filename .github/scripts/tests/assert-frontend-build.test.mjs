#!/usr/bin/env bun
/**
 * `assert-frontend-build.mjs` MUST REFUSE EACH DEFECT IT NAMES, AND PASS A GOOD BUILD.
 *
 * The check is what makes main's frontend build a gate (#1476/#1498: a build naming no commit, or two
 * ids, surfaced only at a release tag). A gate over a fixture nobody builds is vacuous, so each case
 * below builds a minimal artefact tree and breaks exactly one thing. `ci.yml` calling the script is
 * pinned at the end - a check no workflow calls does not exist.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProblems } from '../assert-frontend-build.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
let failures = 0;
const ok = (what, cond) => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`);
};

/** A frontend dir holding a good build, with `mutate` free to break one thing in it. */
function fixture(mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'frontend-build-'));
  const put = (rel, body) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  put('build/client/_app/version.json', JSON.stringify({ version: `1791268984387-${SHA.slice(0, 9)}` }));
  put('build/client/_app/immutable/assets/mls_wasm_bg.B6cRKKFF.wasm', '\0asm');
  put('src/lib/proto/canari.js', '//');
  mutate(put, dir);
  return dir;
}

const run = (mutate, sha = SHA) => {
  const dir = fixture(mutate);
  try {
    return buildProblems(dir, sha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

ok('a good build has no problem', run().length === 0);
ok(
  'a build that names no commit (the pre-#1476 shape, a bare timestamp) is refused',
  run((put) => put('build/client/_app/version.json', '{"version":"1791268984387"}')).some((p) =>
    p.includes('no build stamp')
  )
);
ok(
  'a build of ANOTHER commit is refused',
  run(() => {}, 'f'.repeat(40)).some((p) => p.includes('names commit'))
);
ok(
  'a build with no version.json is refused',
  run((put, dir) => rmSync(join(dir, 'build/client/_app/version.json'))).some((p) =>
    p.includes('wrote no version stamp')
  )
);
ok(
  'a build with no wasm is refused',
  run((put, dir) =>
    rmSync(join(dir, 'build/client/_app/immutable/assets/mls_wasm_bg.B6cRKKFF.wasm'))
  ).some((p) => p.includes('exactly one mls_wasm_bg'))
);
ok(
  'a build with two wasm files is refused',
  run((put) => put('build/client/_app/immutable/assets/mls_wasm_bg.OTHER.wasm', '\0asm')).some((p) =>
    p.includes('exactly one mls_wasm_bg')
  )
);
ok(
  'a missing generated protobuf module is refused',
  run((put, dir) => rmSync(join(dir, 'src/lib/proto/canari.js'))).some((p) => p.includes('protobuf'))
);

const ci = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'workflows', 'ci.yml'),
  'utf8'
);
ok('ci.yml runs the production build on push to main', /if: github\.event_name == 'push'[\s\S]{0,400}BUILD_WEB: '1'/.test(ci));
ok('ci.yml runs assert-frontend-build.mjs on it', ci.includes('assert-frontend-build.mjs frontend "${{ github.sha }}"'));

console.log(failures ? `[frontend-build] ${failures} FAILURE(S)` : '[frontend-build] clean');
process.exit(failures ? 1 : 0);
