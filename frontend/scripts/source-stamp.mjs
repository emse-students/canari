#!/usr/bin/env node
/**
 * WHAT SOURCE A BUILD WAS MADE FROM - the question `bundle.mjs` could not ask.
 *
 * The campaign already proves two things about the code under test: a running page carries the build
 * id it was served (`bundle.mjs`), and the deployment serves the build id it was built with
 * (`check-bundle-consistency.mjs`). Neither says whether that build was made from THE SOURCE IN THE
 * TREE, and on 2026-09-07 that gap cost GRP-3 and GRP-8 a `FAIL` each: a `vite build` launched in the
 * background overlapped a `git switch`, so it read the tree at a moment when the branch change had
 * reverted one component, and the estate then served an artefact that was internally consistent,
 * correctly deployed, correctly reloaded onto by both browsers - and missing the very attribute the
 * two rows address members through. Every existing check passed. The verdicts said the product was
 * broken; the artefact was.
 *
 * SO THE STAMP IS A CONTENT HASH, NOT A CLOCK. An mtime answers "which is newer", which a checkout
 * changes without changing a byte, and a build that legitimately predates a `touch` is not stale. The
 * question is "was this artefact made from these bytes", and only the bytes can answer it.
 *
 * WHAT IS HASHED, and why the generated trees are not:
 * `src/lib/paraglide` is compiled from `messages/`, which IS hashed; `src/lib/proto` from the `.proto`
 * files; `src/lib/wasm` from the Rust crates, and `deployed-wasm-check.mjs` already compares the
 * SERVED wasm against a fresh compile, which is the stronger claim and the only one that can be made
 * about a binary this does not build. Hashing them here would make the stamp differ after an
 * ordinary `bun run generate` that changed nothing, which is how a gate earns the right to be
 * ignored.
 *
 * The stamp is written next to the artefact it describes (`build/source-stamp.json`) rather than
 * served: the consumer is the harness on this machine, comparing the LOCAL estate against the tree it
 * is about to attribute verdicts to. A production deployment legitimately lags the tree, and a check
 * that said otherwise would be wrong there rather than useful.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the stamp lives - beside the artefact, so a build directory carries its own provenance. */
export const STAMP_FILE = join(FRONTEND, 'build', 'source-stamp.json');

/**
 * The trees and files whose bytes decide what the client bundle contains.
 *
 * A missing entry is not an error: `messages/` and the configs are always there, but listing a path
 * that a future layout moves should degrade to "that path contributes nothing", not to a crash in a
 * gate that runs on every build.
 */
const INPUTS = [
  'src',
  'messages',
  'static',
  'vite.config.js',
  'svelte.config.js',
  'package.json',
  'project.inlang/settings.json',
];

/** Generated, and derived from something already hashed above - see the header. */
const GENERATED = new Set(['paraglide', 'wasm', 'proto']);

/** Every file under `dir` that contributes to the stamp, as repo-relative paths, sorted. */
function filesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (GENERATED.has(entry.name)) continue;
      out.push(...filesUnder(join(dir, entry.name)));
    } else {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * The hash of the source this build should have been made from.
 *
 * The PATH is hashed alongside the bytes: a file moved from one component to another changes what the
 * bundle contains even when no byte of it changed, and a hash of contents alone would call that the
 * same source. Sorted, so two machines walking the tree in a different order agree.
 *
 * @returns {{ sha: string, files: number }}
 */
export function sourceStamp() {
  const files = [];
  for (const input of INPUTS) {
    const full = join(FRONTEND, input);
    if (!existsSync(full)) continue;
    const stat = readdirSyncSafe(full);
    if (stat === null) files.push(full);
    else files.push(...filesUnder(full));
  }
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(FRONTEND, file).replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return { sha: hash.digest('hex').slice(0, 16), files: files.length };
}

/** `readdirSync` on a file throws ENOTDIR; that is how this tells a listed file from a listed tree. */
function readdirSyncSafe(path) {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

/**
 * Record what this build was made from, beside the build.
 *
 * @param {string} id - the `__sveltekit_<id>` the build stamped, so a reader can tell WHICH artefact
 *   this describes without trusting the directory to have been left alone.
 */
export function writeSourceStamp(id) {
  const { sha, files } = sourceStamp();
  writeFileSync(STAMP_FILE, `${JSON.stringify({ id, sha, files }, null, 2)}\n`);
  return { sha, files };
}

/** The stamp of the build sitting in `build/`, or `null` when there is none to read. */
export function readSourceStamp() {
  try {
    return JSON.parse(readFileSync(STAMP_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * THE DECISION, WITH NO I/O IN IT - why a verdict taken now would name the wrong code, or `null`.
 *
 * Separated from the reading so it can be pinned without a build directory, a running estate or the
 * harness's out-of-tree `names.mjs`: `sourcestamp-selftest.mjs` exercises every branch on plain
 * objects, which is what lets this run in CI on a fresh checkout.
 *
 * TWO QUESTIONS, AND EITHER ONE ALONE MISSES THE CASE THAT COST TWO ROWS. `id` says the estate is
 * serving the last build made here; `sha` says that build was made from these bytes. On 2026-09-07
 * the first was TRUE and the second false, and every check the rig had asked only the first.
 *
 * @param {string} deployed - the `__sveltekit_<id>` the origin is serving right now
 * @param {{ id: string, sha: string, files: number } | null} stamp - {@link readSourceStamp}
 * @param {{ sha: string, files: number }} now - {@link sourceStamp}, over the tree as it stands
 * @returns {string|null} the reason to refuse to measure, or `null` when the estate serves this tree
 */
export function staleReason(deployed, stamp, now) {
  if (!stamp) {
    return (
      `the local estate serves ${deployed} and \`frontend/build/source-stamp.json\` does not exist - ` +
      'nothing can say which source that bundle was built from. Run `make local-frontend`.'
    );
  }
  if (stamp.id !== deployed) {
    return (
      `the local estate serves ${deployed} but the last build here produced ${stamp.id} - the ` +
      'deployment is older than the build directory. Run `make local-frontend`.'
    );
  }
  if (stamp.sha !== now.sha) {
    return (
      `the local estate serves ${deployed}, built from source ${stamp.sha} (${stamp.files} files), ` +
      `and the tree is now ${now.sha} (${now.files} files) - every verdict would name a build that ` +
      'does not contain the change under test. Run `make local-frontend`.'
    );
  }
  return null;
}
