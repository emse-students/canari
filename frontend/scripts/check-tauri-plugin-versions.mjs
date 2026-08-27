#!/usr/bin/env node
/**
 * Asserts that every Tauri package declared twice is declared at the same major.minor.
 *
 * A Tauri plugin is two artefacts that must agree: a JS package in `package.json` and a Rust crate
 * in `src-tauri/Cargo.lock`. The JS half calls commands the Rust half registers, so a version skew
 * is a skew between a caller and its callee - and the Tauri CLI refuses to build at all when it
 * sees one:
 *
 *     Found version mismatched Tauri packages. [...]
 *     tauri-plugin-log (v2.8.0) : @tauri-apps/plugin-log (v2.9.0)
 *
 * That refusal is correct and useless, because of WHERE it happens. Nothing in this repository
 * compiles the Tauri app: `bun run check`, `lint`, `format` and the whole CI pipeline read the JS
 * side only. The first thing that runs `tauri build` is a RELEASE workflow, so a skew introduced by
 * an ordinary dependency bump stays invisible until the moment it kills the release - which is
 * exactly what happened on 2026-08-27, when `ba6e4bf7` re-resolved the JS tree to
 * `@tauri-apps/plugin-log` 2.9.0 against a `Cargo.lock` still pinning 2.8.0, and Android Release,
 * AppImage Release and iOS Release all died in their first thirty seconds.
 *
 * A `bun install` or `bun update` RE-RESOLVES the JS tree and touches no Cargo lockfile, so the two
 * halves drift by default and only ever converge deliberately. This check is the cheap half of that
 * build: pure text against two committed files, no toolchain, no network, seconds. It cannot replace
 * compiling the app, and it is not meant to - it names the one class of failure that a release is
 * otherwise the first thing to discover.
 *
 * Only major.minor is compared, which is precisely what the CLI itself enforces: a patch may differ.
 *
 * Exits non-zero with every pair that disagrees.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Crate name for a `@tauri-apps/*` JS package.
 *
 * The mapping is mechanical for plugins (`@tauri-apps/plugin-x` -> `tauri-plugin-x`) and named for
 * the two that are not plugins. Returning `null` marks a package with no Rust counterpart, which is
 * a normal state and not a finding: `@tauri-apps/cli` ships the CLI as a binary here.
 */
function crateFor(jsPackage) {
  if (jsPackage === '@tauri-apps/api') return 'tauri';
  if (!jsPackage.startsWith('@tauri-apps/plugin-')) return null;
  return jsPackage.replace('@tauri-apps/', 'tauri-');
}

/** `1.2.3` -> `1.2`. The unit the Tauri CLI compares, so the unit this check compares. */
function majorMinor(version) {
  const [major, minor] = version.split('.');
  return `${major}.${minor}`;
}

/**
 * Version of `crate` as PINNED by the lockfile.
 *
 * The lockfile and not `Cargo.toml`, because the manifest carries a RANGE (`tauri-plugin-log = "2"`)
 * which says nothing about what will be built, while the lockfile carries the single version that
 * will be. The mismatch this file exists for lived entirely inside one such range.
 */
function lockedVersion(lock, crate) {
  const block = new RegExp(`\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = "([^"]+)"`);
  return lock.match(block)?.[1] ?? null;
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lock = readFileSync(join(ROOT, 'src-tauri', 'Cargo.lock'), 'utf8');

const declared = { ...pkg.dependencies, ...pkg.devDependencies };
const mismatches = [];
let compared = 0;

for (const [jsPackage, range] of Object.entries(declared)) {
  const crate = crateFor(jsPackage);
  if (!crate) continue;
  const locked = lockedVersion(lock, crate);
  // A crate absent from the lockfile is a JS package whose Rust half this app does not build. Not a
  // finding: the CLI compares what is present, and so does this.
  if (!locked) continue;
  const js = range.replace(/^[\^~]/, '');
  compared += 1;
  if (majorMinor(js) !== majorMinor(locked)) {
    mismatches.push(`  ${crate} (v${locked}) : ${jsPackage} (v${js})`);
  }
}

if (mismatches.length > 0) {
  console.error(
    `[tauri-version-check] ${mismatches.length} mismatched Tauri package(s) - ` +
      `every tauri build WILL refuse to start:\n${mismatches.join('\n')}\n` +
      `  Fix the Rust side: cd frontend/src-tauri && cargo update -p <crate>\n` +
      `  (or the JS side, if the crate is the one that must not move)`
  );
  process.exit(1);
}

console.log(`[tauri-version-check] ${compared} Tauri package pair(s) agree on major.minor`);
