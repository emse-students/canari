#!/usr/bin/env node
/**
 * Asserts that the freshly written `build/` can actually boot.
 *
 * SvelteKit stamps every build with a per-build identifier and uses it as the name of the global
 * the bootstrap hands its payload to: `build/index.html` declares `__sveltekit_<id> = { ... }` and
 * the client runtime chunk reads `globalThis.__sveltekit_<id>.data`. The two are only ever equal
 * because they came out of the SAME build - nothing in the toolchain checks it.
 *
 * Two concurrent `vite build` runs writing the same `build/` directory therefore produce an
 * artefact whose HTML carries one id and whose chunks carry the other. It type-checks, it lints, it
 * packs into an APK, and it dies on the splash screen with
 * `TypeError: Cannot read properties of undefined (reading 'data')` - the only symptom, and it
 * names neither the build nor the cause. Measured 2026-08-10: an Android debug build shipped
 * `__sveltekit_5wp7yq` in the HTML against `__sveltekit_10pyqm3` in all four chunks.
 *
 * So the assertion lives here, where it costs one file read and turns a silent poisoning into a
 * failed build. Exits non-zero with what it found.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const ID_PATTERN = /__sveltekit_[a-z0-9]+/g;

/** Collects every distinct `__sveltekit_<id>` token in a file. */
function idsIn(path) {
  return new Set(readFileSync(path, 'utf8').match(ID_PATTERN) ?? []);
}

/** Every emitted JS file under `build/_app/immutable`, recursively. */
function bundleScripts(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...bundleScripts(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const indexHtml = join(BUILD_DIR, 'index.html');
const immutable = join(BUILD_DIR, '_app', 'immutable');
if (!existsSync(indexHtml) || !existsSync(immutable)) {
  console.error(`[bundle-check] no build output at ${BUILD_DIR} - did vite build run?`);
  process.exit(1);
}

const htmlIds = idsIn(indexHtml);
const scriptIds = new Set();
for (const file of bundleScripts(immutable)) for (const id of idsIn(file)) scriptIds.add(id);

// The HTML declares exactly one; the chunks may legitimately not mention it at all (only the
// runtime chunk reads it), but every id they DO mention has to be that one.
const unexpected = [...scriptIds].filter((id) => !htmlIds.has(id));
if (htmlIds.size !== 1 || unexpected.length > 0) {
  console.error(
    `[bundle-check] the build is internally inconsistent and cannot boot.\n` +
      `  index.html declares: ${[...htmlIds].join(', ') || '(none)'}\n` +
      `  the chunks read:     ${[...scriptIds].join(', ') || '(none)'}\n` +
      `  Two builds wrote this directory at once. Remove build/ and rebuild, alone.`
  );
  process.exit(1);
}

console.log(`[bundle-check] build/ is consistent (${[...htmlIds][0]})`);
