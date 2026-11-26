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
 *     be bundled (both are generated, never committed);
 *   - the SERVER STARTS AS THE IMAGE RUNS IT and answers the image's healthcheck (`ssrStartProblems`).
 *
 * `main`'s build is NOT reused by the release: a build bakes its estate's `VITE_*` origins in
 * (`build.yml`), so production's cannot be re-tagged from a build made without them.
 *
 *   bun assert-frontend-build.mjs <frontend-dir> <commit-sha>
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { parseBuildStamp } from '../../tools/cross-client-harness/buildstamp.mjs';

/** The page `Dockerfile.frontend-ssr`'s HEALTHCHECK fetches; the probe asks for the same one. */
const HEALTHCHECK_PATH = '/login';

/** adapter-node's own ready line (`server/adapter-index.js`): the readiness is an event, not a wait. */
const LISTENING = /^Listening on (http:\/\/\S+)/;

/**
 * THE SERVER IS STARTED THE WAY THE SSR IMAGE STARTS IT (2026-11-26). `Dockerfile.frontend-ssr`
 * copies `frontend/build` and runs `node index.js` with NO `node_modules`, and adapter-node leaves
 * every `dependencies` entry of `package.json` external. A server module that reaches a package
 * (v1.8.2-alpha.5: the in-app browser gate -> `openInApp` -> `appVersion` ->
 * `@tauri-apps/plugin-os`) therefore builds green and dies at start with ERR_MODULE_NOT_FOUND. No
 * reading of the chunks says which of them node loads (with `ssr = false` most are never imported),
 * so this MEASURES it: the build is copied to a fresh temporary directory with no `node_modules`
 * above it, run under `node` (the image's runtime - bun would auto-install a missing package and
 * hide the defect), and must print its ready line and answer the healthcheck page with 200.
 *
 * It ends on events only: the ready line, or the process exiting first. A hang is bounded by the CI
 * job's own timeout, not by a clock here.
 *
 * @param {string} buildDir the adapter-node `build/` directory
 * @param {string} [nodeBin] the node executable
 * @returns {Promise<string[]>} one sentence per failure; empty when the server started and answered
 */
export async function ssrStartProblems(buildDir, nodeBin = 'node') {
  const root = mkdtempSync(join(tmpdir(), 'ssr-start-'));
  const app = join(root, 'app');
  cpSync(buildDir, app, { recursive: true });
  // NODE_PATH or NODE_OPTIONS from the caller could resolve a package the image does not have.
  const env = { ...process.env, PORT: '0', HOST: '127.0.0.1' };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const child = spawn(nodeBin, ['index.js'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on('close', (code) => resolve({ code })));
  try {
    const ready = await new Promise((resolve) => {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        const m = LISTENING.exec(line);
        if (m) resolve({ url: m[1] });
      });
      child.on('error', (e) => resolve({ spawnError: e }));
      exited.then(({ code }) => resolve({ code }));
    });
    if (ready.spawnError) {
      return [`could not run '${nodeBin}' to start the SSR server: ${ready.spawnError.message}`];
    }
    if (!ready.url) {
      return [
        `the SSR server exited (code ${ready.code}) before listening, run as the image runs it (no node_modules): ${stderr.trim()}`,
      ];
    }
    const res = await fetch(new URL(HEALTHCHECK_PATH, ready.url));
    if (res.status !== 200) {
      return [
        `the SSR server answered ${HEALTHCHECK_PATH} with ${res.status}, not 200 - the image's healthcheck would fail: ${stderr.trim()}`,
      ];
    }
    return [];
  } finally {
    child.kill();
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
}

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
    problems.push(
      `expected exactly one mls_wasm_bg.<hash>.wasm in ${assets}, found ${wasm.length}`
    );
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
  const problems = [
    ...buildProblems(frontendDir, sha),
    ...(await ssrStartProblems(join(frontendDir, 'build'))),
  ];
  for (const p of problems) console.error(`::error::${p}`);
  if (problems.length > 0) process.exit(1);
  console.log(
    `[frontend-build] ok - the build names ${sha.slice(0, 9)}, carries its wasm and protobuf module, and its server starts with no node_modules`
  );
}
