#!/usr/bin/env bun
/**
 * IS THE iOS COMPILE REALLY A GATE, AND DOES IT SKIP FOR THE RIGHT PATHS?
 *
 * `compile-ios-app` exists so a Swift error fails a pull request instead of a release cut. Four ways
 * it stops being that, none of which any run would show:
 *
 * - it is missing from `ci-passed.needs` (`ci-passed-gate.test.mjs` derives that list too; this
 *   names the job so the failure says WHICH gate vanished);
 * - it loses its `run-ios-app` condition and burns a macOS runner on every pull request - or is
 *   gated on an output `changes` never writes and never runs at all;
 * - it grows a secret or a write permission, which a Dependabot or fork pull request does not get;
 * - the path filter drifts: a Swift file stops triggering it, or a Rust-only change starts to.
 *
 * The filter is LIFTED out of `ci.yml` and applied to sample paths, never copied here.
 *
 * Usage: bun .github/scripts/tests/ios-compile-job.test.mjs   (no arguments, no network)
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ci = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const iosYml = readFileSync(resolve(repoRoot, '.github/workflows/ios.yml'), 'utf8');

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  console.log(`  FAIL ${m}`);
  failures += 1;
};
const check = (cond, good, evil) => (cond ? ok(good) : bad(evil));

const jobs = ci.slice(ci.indexOf('\njobs:\n'));
const start = jobs.indexOf('\n  compile-ios-app:\n');
if (start === -1) {
  bad('ci.yml has no `compile-ios-app` job');
  process.exit(1);
}
const rest = jobs.slice(start + 1);
const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/);
const job = next === -1 ? rest : rest.slice(0, next + 1);
// Comments may mention secrets; the claim is about what the job READS.
const code = job
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

console.log('the job is a gate, behind the right switch, with nothing a pull request lacks:');
check(/runs-on: macos-/.test(code), 'runs on macOS', 'does not run on a macOS runner');
check(
  /if: \$\{\{ needs\.changes\.outputs\.run-ios-app == 'true' \}\}/.test(code),
  'gated on `run-ios-app`',
  'is not gated on `run-ios-app` - a macOS runner on every pull request',
);
check(
  /run-ios-app: \$\{\{ steps\.matrix\.outputs\.ios_app \}\}/.test(ci),
  '`changes` forwards `ios_app` as `run-ios-app`',
  '`changes` never declares `run-ios-app`, so the job can never run',
);
check(!/secrets\./.test(code), 'reads no secret', 'reads a secret - a Dependabot run has none');
check(
  /permissions:\s*\n\s+contents: read/.test(code) && !/contents: write/.test(code),
  'holds contents: read only',
  'holds more than contents: read',
);
check(
  /CI passed[\s\S]*needs:\s*\[[^\]]*\bcompile-ios-app\b/.test(ci.slice(ci.indexOf('\n  ci-passed:\n'))),
  '`CI passed` needs it',
  '`CI passed` does not need `compile-ios-app` - a Swift error would merge',
);
check(
  /bash \.github\/scripts\/ios-app-compile\.sh/.test(code),
  'runs ios-app-compile.sh',
  'does not run ios-app-compile.sh',
);
check(
  /bash \.github\/scripts\/ios-libapp\.sh/.test(iosYml),
  'ios.yml shares the static-library script',
  'ios.yml no longer calls ios-libapp.sh - the two builds can drift',
);
check(
  !/xcodebuild archive/.test(readFileSync(resolve(repoRoot, '.github/scripts/ios-app-compile.sh'), 'utf8').replace(/^\s*#.*$/gm, '')),
  'compile script never archives',
  'compile script archives - it is meant to be compile-only',
);

console.log('the path filter:');
const m = ci.match(/# -- iOS app compile --[\s\S]*?if ([\s\S]*?); then\n\s+echo "ios_app=true"/);
if (!m) {
  bad('cannot find the ios_app filter in ci.yml');
  process.exit(1);
}
const patterns = [...m[1].matchAll(/has '([^']+)'/g)].map((x) => new RegExp(x[1]));
const hit = (p) => patterns.some((r) => r.test(p));
for (const p of [
  'frontend/src-tauri/gen/apple/canari_Share/ShareRules.swift',
  'frontend/src-tauri/gen/apple/canari.xcodeproj/project.pbxproj',
  'frontend/src-tauri/patches/tauri-plugin-keystore/ios/Sources/KeystorePlugin.swift',
  'frontend/src-tauri/plugins/some-plugin/ios/Package.swift',
  'frontend/src-tauri/src/bridge/thing.mm',
  '.github/scripts/ios-app-compile.sh',
  'frontend/src-tauri/Cargo.toml',
  'frontend/src-tauri/build.rs',
  'frontend/src-tauri/tauri.conf.json',
  'frontend/src-tauri/tauri.ios.conf.json',
]) {
  check(hit(p), `triggers on ${p}`, `does NOT trigger on ${p}`);
}
for (const p of [
  'frontend/src-tauri/src/lib.rs',
  'frontend/src-tauri/Cargo.lock',
  'frontend/src-tauri/tauri.local.conf.json',
  'frontend/src-tauri/gen/android/app/build.gradle.kts',
  'frontend/src/lib/mobile/ios.ts',
  'apps/core-service/src/main.ts',
  'docs/wiki/cicd.md',
]) {
  check(!hit(p), `skips on ${p}`, `triggers on ${p} - a macOS runner for nothing Apple`);
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall ok');
