/**
 * EVERY `.lucide-*` CLASS THIS RIG AIMS AT MUST BE ONE THE APPLICATION ACTUALLY RENDERS.
 *
 * ## The bug this exists to end
 *
 * `MUT-12` clicked `svg.lucide-smile` to open the reaction picker. Lucide renamed that icon and the
 * frontend followed - `MessageBubbleToolbar.svelte` imports `FaceSlightlySmiling`, whose rendered
 * class is `lucide-face-slightly-smiling` - and the check kept aiming at a class that had not
 * existed for some time. What it produced was not a red row saying "the icon moved": it was
 * `no settled .lucide-smile action on the row of MUT12-... within 4s - last read: null`, which reads
 * as the ACTION BAR failing to appear, and both legs of the check `ERROR`ed on it. Measured
 * 2026-09-04, on a run where the twenty other MUT rows passed.
 *
 * That is the standing hazard of addressing a product by a third party's class name: the rename
 * happens in a dependency, the app takes it in one line, and every instrument pointed at the old
 * name fails in a way that accuses the app. `@lucide/svelte` is on the ecosystem's "latest version,
 * every stale component corrected, EVERYWHERE" mandate, so this will happen again.
 *
 * ## Why it compares against the SOURCE and not the package
 *
 * An icon that exists in `node_modules` but that the app never imports is no better a target than
 * one that does not exist at all - the class would still never appear in the DOM. So the truth is
 * `frontend/src`: the set of icons the application imports from `@lucide/svelte`, kebab-cased the
 * way the package's own `Icon.svelte` composes `lucide-${name}`. It also means this gate needs no
 * install to run, which is what lets it sit in `make test-harness` beside the others.
 *
 *   bun archive/lucide-selftest.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_ROOT } from '../scriptpath.mjs';

const FRONTEND_SRC = fileURLToPath(new URL('../../../frontend/src/', import.meta.url));

/** Every file under `dir` whose extension is in `exts`, recursively. */
function walk(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'paraglide' || name === 'wasm') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts));
    else if (exts.includes(extname(full))) out.push(full);
  }
  return out;
}

/**
 * The class Lucide gives an icon component, from its exported name.
 *
 * `Icon.svelte` renders `lucide-${name}` where `name` is the icon's kebab-case id, so this is the
 * package's own naming rule and not a guess: a boundary before every capital that follows a
 * lower-case letter or digit, and one before every digit that follows a letter (`Trash2` ->
 * `trash-2`, `PinOff` -> `pin-off`, `FaceSlightlySmiling` -> `face-slightly-smiling`).
 */
const kebab = (name) =>
  name.replace(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])/g, '-').toLowerCase();

const IMPORT = /import\s*\{([^}]*)\}\s*from\s*'@lucide\/svelte'/g;

/** Every lucide class the application can actually render. */
function classesTheAppRenders() {
  const classes = new Set();
  for (const file of walk(FRONTEND_SRC, ['.svelte', '.ts'])) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(' as ')[0].trim();
        if (name) classes.add(`lucide-${kebab(name)}`);
      }
    }
  }
  return classes;
}

/** Every lucide class this rig aims at, with the files that aim at it. */
function classesTheRigAimsAt() {
  const aimed = new Map();
  for (const file of walk(HARNESS_ROOT, ['.mjs'])) {
    // This file names the stale class in its own docblock, deliberately - it is the story of why
    // the gate exists, and a gate that fails on its own explanation is a gate nobody keeps.
    if (file === fileURLToPath(import.meta.url)) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/lucide-[a-z0-9-]+/g)) {
      // `lucide-svelte` is the package's OLD name, which appears in prose about the rename rather
      // than as a selector. It is not an icon and there is nothing to check.
      if (match[0] === 'lucide-svelte') continue;
      if (!aimed.has(match[0])) aimed.set(match[0], []);
      const where = file.replace(HARNESS_ROOT, '').replace(/\\/g, '/');
      if (!aimed.get(match[0]).includes(where)) aimed.get(match[0]).push(where);
    }
  }
  return aimed;
}

const rendered = classesTheAppRenders();
const aimed = classesTheRigAimsAt();

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

// A gate over an empty set is the vacuous pass this project refuses everywhere else: if the walk or
// the regex ever stops matching, both halves go quiet and every assertion below holds trivially.
ok(`the application imports lucide icons at all (${rendered.size} found)`, rendered.size > 50);
ok(`the rig aims at lucide classes at all (${aimed.size} found)`, aimed.size > 0);

for (const [cls, files] of [...aimed].sort()) {
  ok(`${cls} is rendered by the app (aimed at from ${files.join(', ')})`, rendered.has(cls));
}

console.log(
  failures
    ? `[lucide] ${failures} FAILURE(S) - a class this rig clicks is not one the app renders, and a` +
        ' check aiming at it will accuse the application of not showing its action bar'
    : `[lucide] clean - all ${aimed.size} class(es) this rig aims at are rendered by the app`
);
process.exit(failures ? 1 : 0);
