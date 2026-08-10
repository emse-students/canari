#!/usr/bin/env node
/**
 * Asserts that the freshly written `build/` can actually boot.
 *
 * SvelteKit stamps every build with a per-build identifier and uses it as the NAME of the global the
 * bootstrap hands its payload to: the shell declares `__sveltekit_<id> = { ... }` and the client
 * runtime chunk reads `globalThis.__sveltekit_<id>.data`. The two are only ever equal because they
 * came out of the SAME build - nothing in the toolchain checks it.
 *
 * Two concurrent `vite build` runs writing the same `build/` directory therefore produce an artefact
 * whose shell carries one id and whose chunks carry the other. It type-checks, it lints, it packs
 * into an APK, and it dies on the splash screen with
 * `TypeError: Cannot read properties of undefined (reading 'data')` - the only symptom, and it names
 * neither the build nor the cause. Measured 2026-08-10: an Android debug build shipped
 * `__sveltekit_5wp7yq` in the HTML against `__sveltekit_10pyqm3` in all four chunks.
 *
 * The invariant checked is the simplest true one: **one build stamps exactly one id, and it stamps it
 * everywhere.** Two adapters write it in two shapes, and the check covers both:
 *
 * - adapter-static (mobile/Tauri, `BUILD_WEB` unset): the shell is a FILE, so the id is a literal in
 *   `build/index.html` and in `build/_app/immutable/**`.
 * - adapter-node (`BUILD_WEB=1`, the web deploy): the shell is rendered at REQUEST time, so the id is
 *   never a literal on the server side - it is interpolated from `options.version_hash`. The literal
 *   halves are `build/client/_app/immutable/**` and the prerendered pages; the server half is the
 *   `version_hash` itself, compared separately below.
 *
 * `build/server/` is deliberately never scanned for `__sveltekit_<id>`: the pattern is a NAME shape,
 * not a value, and the server bundle also carries unrelated globals built the same way - notably
 * `__sveltekit_sw`, the service-worker env payload - which a loose scan reports as a second build id
 * on a perfectly good build. (It did, on the first version of this check.)
 *
 * Exits non-zero with what it found.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');
const SERVER_DIR = join(BUILD_DIR, 'server');
/** The global's name, as written literally by the shell and by every client chunk. */
const ID_PATTERN = /__sveltekit_[a-z0-9]+/g;
/** adapter-node's server half: the same id, without the prefix, as a plain value. */
const VERSION_HASH_PATTERN = /version_hash:\s*["']([a-z0-9]+)["']/g;
/** Only these carry the stamp; reading the rest (wasm, images, source maps, .br/.gz) buys nothing. */
const SCANNED = /\.(js|mjs|html)$/;

/**
 * Every scannable file under `dir`, recursively, skipping `build/server` - see the header for why
 * scanning it for an id NAME is wrong rather than merely redundant.
 */
function scannableFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (full === SERVER_DIR) continue;
    if (entry.isDirectory()) out.push(...scannableFiles(full));
    else if (SCANNED.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every distinct capture of `pattern` across `files`, mapped to the SET of files carrying it - a
 * chunk mentions the id once per read, and listing one file three times reads as three carriers.
 */
function collect(files, pattern, capture) {
  const carriers = new Map();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      const value = capture ? match[1] : match[0];
      const set = carriers.get(value) ?? new Set();
      set.add(relative(BUILD_DIR, file));
      carriers.set(value, set);
    }
  }
  return carriers;
}

/** `id: file, file, +N more` - a failure must name where each half came from. */
function describe(carriers) {
  return [...carriers]
    .map(([value, set]) => {
      const names = [...set];
      const shown = names.slice(0, 3).join(', ');
      return `  ${value}: ${shown}${names.length > 3 ? `, +${names.length - 3} more` : ''}`;
    })
    .join('\n');
}

function fail(message) {
  console.error(`[bundle-check] ${message}`);
  process.exit(1);
}

if (!existsSync(BUILD_DIR)) fail(`no build output at ${BUILD_DIR} - did vite build run?`);

const files = scannableFiles(BUILD_DIR);
if (files.length === 0) fail(`${BUILD_DIR} holds no scannable output - did vite build run?`);

const ids = collect(files, ID_PATTERN, false);

if (ids.size === 0) {
  // Not a pass: every SvelteKit build stamps an id somewhere on the client side, so finding none
  // means this check is looking at the wrong thing and would green-light the corruption it exists to
  // catch.
  fail(
    `no __sveltekit_<id> found in any of ${files.length} client file(s) under ${BUILD_DIR}.\n` +
      `  Either the output is not a SvelteKit build, or the stamp has changed shape - fix this check.`
  );
}

if (ids.size > 1) {
  fail(
    `the build is internally inconsistent and cannot boot - ${ids.size} build ids in one output:\n` +
      `${describe(ids)}\n` +
      `  Two builds wrote this directory at once. Remove build/ and rebuild, alone.`
  );
}

const [id] = ids.keys();

// adapter-node only. The server renders the shell, so ITS notion of the id has to match the chunks'
// even though it never writes the name out.
let serverNote = '';
if (existsSync(SERVER_DIR)) {
  const hashes = collect(scannableFiles(SERVER_DIR), VERSION_HASH_PATTERN, true);
  if (hashes.size === 0) {
    fail(
      `build/server/ carries no version_hash - the server renders the shell from it, so this check\n` +
        `  can no longer prove the rendered shell matches the chunks. Fix this check.`
    );
  }
  if (hashes.size > 1) {
    fail(
      `build/server/ carries ${hashes.size} distinct version_hash values:\n${describe(hashes)}\n` +
        `  Two builds wrote this directory at once. Remove build/ and rebuild, alone.`
    );
  }
  const [hash] = hashes.keys();
  if (`__sveltekit_${hash}` !== id) {
    fail(
      `the rendered shell will not match the chunks - the server renders\n` +
        `  __sveltekit_${hash} while the client reads ${id}.\n` +
        `  Two builds wrote this directory at once. Remove build/ and rebuild, alone.`
    );
  }
  serverNote = ', server agrees';
}

console.log(`[bundle-check] build/ is consistent (${id}, ${files.length} files${serverNote})`);
