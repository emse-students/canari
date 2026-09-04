/**
 * THE INDEX OF EVERY SCRIPT IN THIS RIG, GENERATED FROM THE SCRIPTS THEMSELVES.
 *
 * WHY THIS EXISTS, AND IT IS NOT TIDINESS. A hand-written inventory is consulted, believed, and
 * wrong. Measured on 2026-09-04 against `README.md`'s `## The files`: it named 88 of the 155 scripts,
 * FOUR atoms at the root appeared nowhere in it, SIXTY-NINE archived scripts were undocumented, and
 * 45 of its references pointed at a root the files had just left. An index in that state does not
 * merely fail to help - it sends the reader to write the thing again, which is exactly what the user
 * reported: *"Plusieurs fois, tu as recode des choses qui existaient deja parce que le script n'avait
 * pas ete trouve"* (2026-09-04). `atoms.mjs` records the same cost independently: a third
 * `createGroup` was written because the first two were not findable.
 *
 * **SO THE INDEX IS DERIVED, NEVER MAINTAINED.** Every script already opens with a docblock whose
 * first sentence says what it is - 154 of 155 did on the day this was written - and that sentence is
 * the one thing guaranteed to be updated when the script changes, because it sits in the file being
 * edited. Reading it here means the index cannot disagree with the tree: there is only one copy of
 * the fact, and it lives next to the code.
 *
 * **`--check` IS THE HALF THAT MAKES IT STICK.** Generating a good index once buys one session of
 * accuracy; `make test-harness` runs this with `--check`, so a script added, moved or renamed
 * without regenerating FAILS the gate. A script with no docblock fails it too - "documented" is
 * then a property the tree HAS rather than one a session is asked to remember.
 *
 * Usage:
 *   bun inventory.mjs            # rewrite INVENTORY.md from the tree
 *   bun inventory.mjs --check    # exit 1 if INVENTORY.md is not what the tree would produce
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'INVENTORY.md');

/** The two halves of the rig, and what each half means. Order here is the order in the file. */
const SECTIONS = [
  {
    dir: '.',
    title: 'Atoms and libraries - the harness root',
    blurb:
      'One GESTURE each, or the vocabulary a gesture is built from. An atom ends on a fact rather ' +
      'than a clock, reads before it acts so a second call is a read, and addresses the product ' +
      'structurally rather than by pixel or wording. Nothing here takes a verdict. ' +
      'See [`atoms.mjs`](atoms.mjs) for the contract and the grouped inventory.',
  },
  {
    dir: 'archive',
    title: 'Rows - `archive/`',
    blurb:
      'One QUESTION each, composed of gestures, ending in a verdict in `results.ndjson`. They still ' +
      'run and the 14 gated self-tests live here. See [`archive/README.md`](archive/README.md).',
  },
];

/**
 * The first sentence of a file's leading docblock - what the script says it is.
 *
 * A shebang may precede it, and the sentence may be the whole first line rather than end in a full
 * stop, because these headers are written as titles. Returns null when there is no docblock at all,
 * which `--check` treats as a failure rather than a blank cell: a script nobody can identify from
 * its first line is the one that gets rewritten.
 */
function headline(path) {
  const src = readFileSync(path, 'utf8').slice(0, 4000);
  // BOTH DOCBLOCK SHAPES. `shot.mjs` states its purpose perfectly well on ONE line -
  // `/** ... */` - and a matcher that knew only the multi-line form reported it as
  // undocumented, which would have made this gate demand a pointless edit to a file that was
  // already right. A gate must accuse real omissions only, or it teaches its reader to work
  // around it.
  const m = /\/\*\*\s*(?:\n\s*\*\s*)?(.+?)\s*(?:\n|\*\/)/.exec(src);
  if (!m) return null;
  // Collapse whitespace and strip the markdown emphasis these headers use, which reads as noise in
  // a table cell where every row is already a title.
  return m[1].replace(/\s+/g, ' ').replace(/\*\*/g, '').trim();
}

/** Every `.mjs` in one section directory, sorted, with the sentence each one opens with. */
function scan(dir) {
  const abs = dir === '.' ? HERE : join(HERE, dir);
  return readdirSync(abs)
    .filter((f) => f.endsWith('.mjs'))
    .sort()
    .map((f) => ({ file: f, dir, headline: headline(join(abs, f)) }));
}

/** A table cell must not break the table, and a headline is free prose. */
const cell = (s) => s.replace(/\|/g, '\\|');

function render() {
  const parts = [
    '# The harness, script by script',
    '',
    '**GENERATED - do not edit.** `bun inventory.mjs` rewrites this file from the leading docblock of',
    'every script; `bun inventory.mjs --check` fails `make test-harness` when it is out of date, so it',
    'cannot drift from the tree. To change a line here, change the docblock of the script it names.',
    '',
    '**Read this before writing a new script.** The rig is large and the reason it grew duplicates is',
    'that gestures were not findable - three `createGroup`s, and a session that re-coded what already',
    'existed. Search this file first.',
    '',
  ];
  let total = 0;
  for (const s of SECTIONS) {
    const rows = scan(s.dir);
    total += rows.length;
    parts.push(`## ${s.title}`, '', s.blurb, '', `${rows.length} scripts.`, '', '| script | what it is |', '|---|---|');
    for (const r of rows) {
      const name = s.dir === '.' ? r.file : `${s.dir}/${r.file}`;
      parts.push(`| \`${name}\` | ${cell(r.headline ?? '**NO DOCBLOCK**')} |`);
    }
    parts.push('');
  }
  parts.push(`---`, '', `${total} scripts in total.`, '');
  return parts.join('\n');
}

const wanted = render();
const check = process.argv.includes('--check');

// A script with no headline is reported by NAME rather than as a count: the point of the gate is
// that the next person knows which file to open.
const undocumented = SECTIONS.flatMap((s) =>
  scan(s.dir)
    .filter((r) => !r.headline)
    .map((r) => (s.dir === '.' ? r.file : `${s.dir}/${r.file}`)),
);

if (check) {
  const problems = [];
  if (undocumented.length) {
    problems.push(
      `${undocumented.length} script(s) open with no docblock, so the index cannot say what they are:\n` +
        undocumented.map((f) => `    ${f}`).join('\n'),
    );
  }
  let current = null;
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    problems.push(`${OUT} does not exist - run \`bun inventory.mjs\``);
  }
  if (current !== null && current !== wanted) {
    problems.push('INVENTORY.md is not what the tree would produce - a script was added, moved or renamed. Run `bun inventory.mjs`.');
  }
  if (problems.length) {
    for (const p of problems) console.error(`FAIL ${p}`);
    process.exit(1);
  }
  console.log(`ok   INVENTORY.md matches the tree (${scan('.').length} atoms, ${scan('archive').length} rows)`);
} else {
  writeFileSync(OUT, wanted);
  console.log(`wrote INVENTORY.md - ${scan('.').length} atoms, ${scan('archive').length} rows`);
  if (undocumented.length) {
    console.log(`NOTE ${undocumented.length} script(s) have no docblock: ${undocumented.join(', ')}`);
  }
}
