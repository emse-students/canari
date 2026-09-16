#!/usr/bin/env node
/**
 * Asserts that a build ships ONE MLS implementation - the one it can run.
 *
 * `TauriMlsService` calls into the Rust side of the app and cannot execute in a browser;
 * `WebMlsService` needs the WASM loader that a Tauri build stubs out. Until 2026-09-16 a runtime
 * ternary picked between two statically imported implementations, so every bundle carried both: the
 * reading of `/login`'s module graph on 2026-09-16 found `TauriMlsService` (48 312 B of source) in
 * the web build and `WebMlsService` (60 538 B) in the Tauri one, compiled and evaluated on every
 * boot for nothing.
 *
 * `platformMlsService()` in `vite.config.js` now resolves that seam when the bundle is built, and
 * this is what says it worked. It has to be checked on the OUTPUT rather than on the config,
 * because the failure it guards against is silent in both directions: a web build that keeps the
 * native implementation only wastes bytes, while a native build that keeps the WEB one boots a
 * second, divergent MLS state beside the real one - and nothing else in the pipeline would say a
 * word about either.
 *
 * Each platform module carries a token no minifier rewrites (`canari-mls-platform:web` /
 * `:native`). This counts them across the emitted JavaScript and fails unless exactly the expected
 * one is there.
 *
 * Exits non-zero with what it found.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD = join(ROOT, 'build');

const WEB_TOKEN = 'canari-mls-platform:web';
const NATIVE_TOKEN = 'canari-mls-platform:native';

/**
 * Every emitted JavaScript file under `dir`, recursively.
 *
 * @param {string} dir Directory to walk.
 * @returns {string[]} Absolute paths.
 */
function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

if (!existsSync(BUILD)) {
  console.error('[platform-service] no build/ directory - run the build first');
  process.exit(1);
}

// The same two variables `isNativeBuild()` reads in vite.config.js, and for the same reason: the
// Tauri CLI exports TAURI_ENV_PLATFORM to its beforeBuildCommand, the iOS workflow sets
// TAURI_TARGET by hand.
const expectNative = !!(process.env.TAURI_TARGET || process.env.TAURI_ENV_PLATFORM);
const expected = expectNative ? NATIVE_TOKEN : WEB_TOKEN;
const forbidden = expectNative ? WEB_TOKEN : NATIVE_TOKEN;

const carrying = { [WEB_TOKEN]: [], [NATIVE_TOKEN]: [] };
for (const file of jsFiles(BUILD)) {
  const text = readFileSync(file, 'utf8');
  if (text.includes(WEB_TOKEN)) carrying[WEB_TOKEN].push(relative(ROOT, file));
  if (text.includes(NATIVE_TOKEN)) carrying[NATIVE_TOKEN].push(relative(ROOT, file));
}

if (carrying[forbidden].length > 0) {
  console.error(
    `[platform-service] this build is ${expectNative ? 'NATIVE' : 'WEB'} and ships the ${expectNative ? 'web' : 'native'} MLS implementation, which cannot run in it:\n  ` +
      carrying[forbidden].join('\n  ')
  );
  process.exit(1);
}

if (carrying[expected].length === 0) {
  console.error(
    `[platform-service] no MLS implementation reached the output at all - expected ${expected}. ` +
      'Either the platform seam stopped being imported, or the token was renamed on one side only.'
  );
  process.exit(1);
}

console.log(
  `✅ [platform-service] ${expectNative ? 'native' : 'web'} build ships only its own MLS implementation ` +
    `(${carrying[expected].length} chunk${carrying[expected].length > 1 ? 's' : ''})`
);
