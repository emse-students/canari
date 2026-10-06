#!/usr/bin/env bun
/**
 * Asserts what a PRODUCTION FRONTEND BUILD must carry, on the artefact itself.
 *
 * WHY THIS EXISTS (#1476, #1498, 2026-10-05). The build-id defect - a build that named no commit,
 * then one that stamped two ids into one output - was invisible to every pull request and to main's
 * own CI, because NOTHING built the frontend there: the suite lints, type-checks and runs Vitest.
 * It surfaced only when a release built the frontend, i.e. at the tag. `ci.yml` now builds it ONCE
 * on `push` to `main` (`bun run build`, which already chains the bundle-consistency, platform and
 * emoji checks) and runs this over the result, so the defect class is red on `main` instead.
 *
 * WHAT IT ASSERTS, each a thing a release depends on and no other gate reads off the artefact:
 *   - `build/client/_app/version.json` carries `<builtAtMs>-<sha>` and the sha is the commit being
 *     tested (the same parser the rig uses, so the two cannot disagree about the format);
 *   - the build holds the MLS wasm it will serve, and the generated protobuf module was present to
 *     be bundled (both are generated, never committed).
 *
 * `main`'s build is NOT reused by the release: a build bakes its estate's `VITE_*` origins in
 * (`build.yml`), so production's cannot be re-tagged from a build made without them.
 *
 *   bun assert-frontend-build.mjs <frontend-dir> <commit-sha>
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseBuildStamp } from '../../tools/cross-client-harness/buildstamp.mjs';

/**
 * @param {string} frontendDir the `frontend/` directory a build was just run in
 * @param {string} sha the full commit the build was made from
 * @returns {string[]} one sentence per violated assertion; empty when the build is as it must be
 */
export function buildProblems(frontendDir, sha) {
  const problems = [];

  const versionFile = join(frontendDir, 'build', 'client', '_app', 'version.json');
  if (!existsSync(versionFile)) {
    problems.push(`${versionFile} does not exist - the build wrote no version stamp`);
  } else {
    try {
      const { version } = JSON.parse(readFileSync(versionFile, 'utf8'));
      const { commit } = parseBuildStamp(version, versionFile);
      if (!sha.startsWith(commit)) {
        problems.push(`the build names commit ${commit}, but the commit being tested is ${sha}`);
      }
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
  }

  const assets = join(frontendDir, 'build', 'client', '_app', 'immutable', 'assets');
  const wasm = existsSync(assets)
    ? readdirSync(assets).filter((f) => /^mls_wasm_bg\..+\.wasm$/.test(f))
    : [];
  if (wasm.length !== 1) {
    problems.push(`expected exactly one mls_wasm_bg.<hash>.wasm in ${assets}, found ${wasm.length}`);
  }

  if (!existsSync(join(frontendDir, 'src', 'lib', 'proto', 'canari.js'))) {
    problems.push('the generated protobuf module src/lib/proto/canari.js is missing');
  }

  return problems;
}

if (import.meta.main) {
  const [frontendDir, sha] = process.argv.slice(2);
  if (!frontendDir || !sha) {
    console.error('usage: assert-frontend-build.mjs <frontend-dir> <commit-sha>');
    process.exit(2);
  }
  const problems = buildProblems(frontendDir, sha);
  for (const p of problems) console.error(`::error::${p}`);
  if (problems.length > 0) process.exit(1);
  console.log(`[frontend-build] ok - the build names ${sha.slice(0, 9)} and carries its wasm and protobuf module`);
}
