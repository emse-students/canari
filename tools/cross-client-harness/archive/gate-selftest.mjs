#!/usr/bin/env node
/**
 * EVERY SELF-TEST IN THE CI GATE MUST BE IMPORTABLE ON A MACHINE THAT HAS NO RIG.
 *
 * WHY THIS FILE EXISTS. `make test-harness` grew from three self-tests to seven on 2026-08-24, and
 * two of the four added could not run in CI at all: `names.mjs` is gitignored on purpose - it holds
 * real display names and this repository is PUBLIC - so a script importing it, directly or three
 * modules down, dies with `ERR_MODULE_NOT_FOUND` on a fresh checkout. The CD run of `74e9e1ec`
 * failed exactly that way, and the failure was invisible locally because the file EXISTS here.
 *
 * That is the whole class of defect: a gate widened by adding lines to a recipe, where the thing
 * that makes a candidate eligible is a property of its import graph that nobody can see by reading
 * it. So the property is asserted instead of remembered.
 *
 * IT READS THE MAKEFILE RATHER THAN A LIST OF ITS OWN. A second list would be a second thing to keep
 * in sync, and it would agree with the recipe right up to the moment someone edits the recipe - which
 * is the only moment it had to disagree. `checks-selftest.mjs` reads `checks.mjs` for the same reason.
 *
 * WHAT IT CANNOT SEE. Whether a script that imports only tracked files actually PASSES without a
 * device: `tabguard-selftest.mjs` drives a real browser, and it was caught here only because it also
 * imports `names.mjs`. A pure-import on-device test would still slip through. Nothing short of
 * running the gate on a machine with no rig proves that, which is what CI now does on every push.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// THREE levels: archive/ -> cross-client-harness/ -> tools/ -> the repo root. It was two until the
// 2026-09-04 tidy moved this file down a directory, after which it read `tools/Makefile` and died.
const ROOT = join(HERE, '..', '..', '..');
const REL = 'tools/cross-client-harness';

/** The scripts `make test-harness` actually runs, in recipe order. */
function gatedScripts() {
  const makefile = readFileSync(join(ROOT, 'Makefile'), 'utf8');
  const recipe = makefile.split(/^test-harness:/m)[1];
  if (!recipe) throw new Error('no `test-harness:` target in the Makefile');
  // A recipe ends at the first line that is neither a tab-indented command nor blank.
  const body = recipe.split('\n').slice(1);
  const end = body.findIndex((l) => l.trim() !== '' && !l.startsWith('\t'));
  // THE PATH INSIDE THE HARNESS, NOT THE BARE NAME. The rig stopped being one flat directory on
  // 2026-09-04 - the rows moved to `archive/` - so a bare basename no longer identifies a file, and
  // matching one made every gated self-test read as absent from git.
  return [
    ...(end === -1 ? body : body.slice(0, end))
      .join('\n')
      .matchAll(new RegExp(`(?:bun|node)\\s+\\S*${REL}/(\\S+\\.mjs)`, 'g')),
  ].map((m) => m[1]);
}

/** Everything git will put on a fresh checkout, as paths RELATIVE TO THE HARNESS DIR. */
const tracked = new Set(
  execFileSync('git', ['ls-files', REL], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.startsWith(`${REL}/`))
    .map((l) => l.slice(REL.length + 1))
);

const HARNESS = join(HERE, '..');

/**
 * The source with its COMMENTS removed, so a sentence about an import is not read as one.
 *
 * THE GATE ACCUSED A FILE OF AN IMPORT IT DOES NOT HAVE (2026-09-04). `inventory.mjs` documents, in
 * prose, that one script spells its import `from "./results.mjs"` with double quotes - and the walk
 * below matched that sentence, resolved `results.mjs`, followed it to the gitignored `names.mjs` and
 * failed the whole gate. `inventory.mjs` imports four node builtins and nothing else.
 *
 * **Rewording the comment would have been the wrong fix.** The rig documents import paths in prose
 * all over, deliberately - that is how a reader learns which spelling a call site uses - and a gate
 * that quietly forbids writing one down teaches its reader to work around it, which is how a NUL
 * byte survived in `phone.mjs` for a day. So the parser stops reading prose instead.
 *
 * Conservative on purpose: block comments, and line comments that OWN their line. A trailing `//`
 * is left alone because stripping it means deciding whether the `//` is inside a string, and
 * `'https://...'` would then eat the rest of a line that might carry a real import. A real import
 * never sits on a line that starts with a comment marker, so this is sufficient and cannot
 * under-report - which is the failure direction that matters for a gate.
 */
const withoutComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * Transitive closure of relative imports, as harness-relative paths.
 *
 * IT FOLLOWS `../` AS WELL AS `./`, which it did not have to before the rows moved into `archive/`:
 * every archived script now reaches its libraries by `../`, and a closure blind to that would report
 * a self-test as depending on nothing and pass it for the wrong reason. Silent under-reporting is the
 * worse failure for a gate, so the walk is done on real paths.
 */
function imports(rel, seen = new Set()) {
  if (seen.has(rel)) return seen;
  seen.add(rel);
  let src;
  try {
    src = readFileSync(join(HARNESS, rel), 'utf8');
  } catch {
    return seen; // Absent here too - `tracked` is what decides, and it will say so.
  }
  const dir = dirname(rel);
  for (const m of withoutComments(src).matchAll(/from\s+['"](\.\.?\/[\w.\-/]+)['"]/g)) {
    imports(join(dir, m[1]).replace(/\\/g, '/'), seen);
  }
  return seen;
}

const scripts = gatedScripts();
if (scripts.length === 0) {
  console.error('FAIL the `test-harness` recipe runs no self-test - the gate is empty');
  process.exit(1);
}

const problems = [];
for (const s of scripts) {
  const missing = [...imports(s)].filter((f) => !tracked.has(f));
  if (missing.length) problems.push(`${s} needs ${missing.join(', ')} - not in git, so CI has none of it`);
}

if (problems.length) {
  for (const p of problems) console.error(`  FAIL ${p}`);
  console.error(
    `\n${problems.length} gated self-test(s) cannot run on a fresh checkout. Either make the import ` +
      'pure, or move the script to `test-harness-device` and say in the README what it needs.'
  );
  process.exit(1);
}

console.log(`ok   all ${scripts.length} gated self-tests import only tracked files`);
console.log('all good');
