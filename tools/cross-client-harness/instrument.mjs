/**
 * THE HASH OF WHAT A CHECK MEASURES WITH, as opposed to the hash of the check itself.
 *
 * ## Why a second hash exists at all
 *
 * `results.mjs` already records `checkSha`, the hash of the runner's own source, and `rows.mjs`
 * refuses to believe a verdict whose runner has changed since. That rule was written after HEAL-W2's
 * `FAIL` survived the rewrite that made its own failing branch unreachable, and for a runner it
 * works.
 *
 * **It does not cover what the runner IMPORTS, which is where the measuring is done.** On 2026-09-04
 * `openConversation` in `chat.mjs` was found to be opening the WRONG CONVERSATION - MSG-1 asked for a
 * DM and was handed a group, sent into it, watched the message arrive, and recorded a verdict naming
 * a conversation it never touched. Fixing it changed what every MSG, READ, MUT, FWD and NOTIF row
 * actually looks at. Not one verdict was flagged: `msg1.mjs` had not been edited, so its hash still
 * matched and the board reported the row as believable. The verdicts happened to be re-taken by hand
 * that afternoon, which is luck, not a mechanism.
 *
 * **A column is only evidence for the question it was written to answer.** `checkSha` answers "did
 * this runner change". Nothing answered "did the thing it measures WITH change", and that second
 * question is the one that decides whether a green board means anything - `chat.mjs`, `watch.mjs`,
 * `comm.mjs`, `results.mjs` and `grainedb.mjs` are shared by nearly every row, so one edit there
 * silently ages the whole campaign.
 *
 * ## The graph is DISCOVERED, never listed
 *
 * A hand-kept list of "the shared modules" is the thing that goes stale, and it would go stale in the
 * direction that matters: a module added to a runner's imports and forgotten by the list is invisible
 * exactly when it starts deciding verdicts. So the set is walked from the entry file's own
 * `import`/`export ... from` specifiers, transitively.
 *
 * ## What it deliberately does NOT include
 *
 * **Anything resolving outside this directory.** `names.mjs` here is a POINTER that re-exports
 * `../../../../canari-harness/names.mjs`, which holds credentials and machine-local absolute paths.
 * Hashing that would make every verdict incomparable between two checkouts and would let a changed
 * `STATE_DIR` read as a changed instrument. The in-tree pointer IS hashed, so a change to what the
 * harness imports still counts; the estate a verdict was taken against is recorded separately, by
 * `build` and by the row itself.
 *
 * **Anything under `node_modules` or a bare specifier.** A dependency bump is a different question
 * with a different answer (`bun.lock`, and CI's dependency ceiling), and folding it in here would
 * make every verdict expire on a lockfile change.
 *
 * The digest is taken over `<path relative to this directory>\0<bytes>` for each file, sorted by that
 * relative path, so it is stable across machines and independent of walk order.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * Every relative specifier in a module's source.
 *
 * A REGEX AND NOT A PARSER, DELIBERATELY. The alternative is to import the module to read its
 * bindings, and importing a runner RUNS it - which is how a hash would come to drive a phone. The
 * forms below are the only ones this rig uses, and `archive/instrument-selftest.mjs` asserts each of
 * them: a specifier this misses makes the hash miss a file, which is the failure mode being fixed,
 * so it is asserted rather than hoped for.
 *
 * It cannot tell a real import from one quoted inside a string, and that is the SAFE direction: the
 * worst case is a file counted that nothing actually imports, which over-invalidates a verdict. A
 * path that does not resolve is skipped, so a quoted example costs nothing at all.
 *
 * ## The fifth form: CODE EXECUTED BY NAME, which an import walk cannot see
 *
 * An import graph answers "what does this file LOAD". It does not answer "what does this file RUN",
 * and the two differ everywhere this rig spawns an atom: `phone.mjs` spawns `pin.mjs`, `del.mjs`
 * spawns `mlsdb.mjs`, `healrevoke.mjs` spawns `login.mjs` and `purge-devices.mjs`, `atoms.mjs`
 * spawns whatever it is handed. Those files decide what a row can read, and `pin.mjs` in particular
 * decides whether a phone row can read ANYTHING - and none of them were in any hash.
 *
 * MEASURED 2026-09-05, which is why this exists. `pin.mjs` never exited on its success path, so
 * `phone.unlockPin()` timed out after 120 s and reported `pin.mjs failed` on a pin that had worked;
 * DEL-7 carried that as dirt. Fixing it changed what every `+A1` row that meets the gate is able to
 * observe. Not one verdict was flagged, for the same reason the docstring above gives about
 * `chat.mjs`: the runner's own bytes had not moved. **A column is only evidence for the question it
 * was written to answer**, and "did the thing it measures WITH change" was being answered by a walk
 * that could only see half of what it measures with.
 *
 * ANCHORED ON CALL AND ARRAY POSITION, so prose stays out. Every spawn site in this rig is a bare
 * `.mjs` filename directly after `(`, `[` or `,` - `spawnSync(execPath, ['pin.mjs', ...])`,
 * `run('login.mjs', ...)`. A file NAMED in a comment is not in one of those positions, and a quoted
 * string long enough to be a sentence cannot match a pattern that is a filename end to end. That
 * keeps the over-inclusion the docstring above tolerates from becoming the thing that kills the
 * signal: a hash invalidated by every edit anywhere is worth exactly as much as no hash.
 */
function specifiersIn(source) {
  const out = [];
  // `import x from './y.mjs'`, `import './y.mjs'`, `export * from './y.mjs'`, `import('./y.mjs')`,
  // and a bare `'y.mjs'` in call or array position - a script this one SPAWNS.
  const patterns = [
    /(?:^|\n)\s*import\s+[^;'"]*?from\s*['"](\.[^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+[^;'"]*?from\s*['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /[[(,]\s*['"]([A-Za-z0-9._-]+\.mjs)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source))) out.push(m[1]);
  }
  return out;
}

/** True when `file` is inside this directory - the test that keeps the out-of-tree config out. */
function inHarness(file) {
  const rel = relative(HERE, file);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep + '..');
}

/**
 * The transitive set of in-tree modules an entry file measures with, INCLUDING the entry itself.
 *
 * Returns paths, sorted by their location relative to the harness root, so a caller can report which
 * file moved as well as that something did.
 */
export function instrumentFilesOf(entryFile) {
  const seen = new Set();
  const queue = [resolve(entryFile)];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file) || !statSync(file).isFile()) continue;
    seen.add(file);
    for (const spec of specifiersIn(readFileSync(file, 'utf8'))) {
      // TWO ROOTS FOR A BARE NAME, ONE FOR A RELATIVE SPECIFIER. An `import './x.mjs'` means exactly
      // one file and resolving it anywhere else would be wrong. A SPAWNED name means whatever the
      // spawn's `cwd` makes it mean, and this rig uses two: the spawning file's own directory
      // (`del.mjs` -> `archive/mlsdb.mjs`) and the harness root, which `phone.mjs` and `atoms.mjs`
      // both pass explicitly as `cwd: HERE` (`archive/burn.mjs` -> `pin.mjs`). Both are tried and
      // whichever exists is taken; a name that resolves to neither is skipped like any other.
      const roots = spec.startsWith('.') ? [dirname(file)] : [dirname(file), HERE];
      for (const root of roots) {
        const next = resolve(root, spec);
        // The `inHarness` test is applied to the RESOLVED path rather than to the specifier: `../..`
        // is perfectly ordinary between `archive/` and the root, and only where it LANDS decides
        // whether the file is an instrument or somebody's credentials.
        if (inHarness(next) && existsSync(next)) queue.push(next);
      }
    }
  }
  return [...seen].sort((a, b) => relative(HERE, a).localeCompare(relative(HERE, b)));
}

/**
 * The 12-hex-character digest of that set. `null` when the entry cannot be read, which is the same
 * answer `rows.mjs` already gives for a runner that no longer exists.
 */
export function instrumentShaOf(entryFile) {
  if (!entryFile || !existsSync(entryFile)) return null;
  const h = createHash('sha256');
  for (const file of instrumentFilesOf(entryFile)) {
    h.update(relative(HERE, file).split(sep).join('/'));
    h.update('\0');
    h.update(readFileSync(file));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

// Reported by `inventory.mjs` and used by nothing else; exported so a caller can say WHERE it looked.
export const HARNESS_ROOT = HERE;

// A tiny CLI, because the first question anyone asks of a hash is "what went into it".
if (process.argv[1] && process.argv[1].endsWith('instrument.mjs')) {
  const entry = process.argv[2];
  if (!entry) {
    console.log('usage: bun instrument.mjs <runner.mjs>   # the sha, and every file behind it');
    process.exit(1);
  }
  const target = existsSync(entry) ? entry : join(HERE, entry);
  const files = instrumentFilesOf(target);
  console.log(`[instrument] ${instrumentShaOf(target)}  (${files.length} file(s))`);
  for (const f of files) console.log('  ' + relative(HERE, f).split(sep).join('/'));
}
