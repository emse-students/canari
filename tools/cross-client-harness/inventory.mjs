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
 * **`git add` YOUR NEW SCRIPT FIRST.** The set comes from `git ls-files`, so a brand-new file is
 * invisible here until it is staged, and regenerating before staging writes an index that the gate
 * then rejects one command later. That ordering is a consequence of describing a CHECKOUT rather
 * than a working directory, and it is the right trade: an index must not name a file a fresh clone
 * cannot open.
 *
 * Usage:
 *   bun inventory.mjs            # rewrite INVENTORY.md from the tree
 *   bun inventory.mjs --check    # exit 1 if INVENTORY.md is not what the tree would produce
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'INVENTORY.md');

/**
 * THE ONE THING THAT SEPARATES A ROW FROM A GESTURE: a row WRITES A VERDICT, and it can only do
 * that through `results.mjs`. So the question is asked of the import list rather than of the
 * directory the file happens to sit in.
 *
 * `mark`, `unmet` and `clientBuild` are deliberately NOT here. Sixty scripts import `mark` and it
 * records an OBSERVATION inside a run - a step reached, a condition met - which every gesture is
 * entitled to do. Only these four close a row in `results.ndjson`.
 */
const VERDICT_WRITERS = ['record', 'recordObserved', 'finish', 'finishObserved'];

/**
 * Whether a script ends in a verdict, read off its `results.mjs` import.
 *
 * IT MUST NOT BE A TEXT SEARCH FOR `record(`, and that was the first attempt. `chat.mjs` and
 * `rows.mjs` both DISCUSS `record(...)` in prose - `rows.mjs` says so in as many words, because it
 * parses those very call sites - so a grep classified two libraries as rows. An import list is
 * structure; a mention in a comment is not.
 *
 * Both quote styles, because that is the OTHER thing the first attempt got wrong: `newdevice.mjs`
 * writes `from "./results.mjs"` with double quotes and was reported as writing no verdict, which
 * would have hidden the single genuine finding at the root behind a measurement error.
 */
function writesAVerdict(path) {
  const m = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*results\.mjs['"]/.exec(
    readFileSync(path, 'utf8'),
  );
  if (!m) return false;
  return m[1]
    .split(',')
    .map((s) => s.trim().split(/\s+as\s+/)[0])
    .some((n) => VERDICT_WRITERS.includes(n));
}

/**
 * THE SECTIONS ARE MEASURED, NOT POSITIONAL, AND THAT IS THE POINT OF THIS FILE.
 *
 * The first version had two sections and got them from the DIRECTORY: root was "atoms", `archive/`
 * was "Rows - one QUESTION each, ending in a verdict in `results.ndjson`". **That sentence was
 * false about 52 of the 114 files it covered.** Measured 2026-09-04: `archive/` holds 62 rows, 13
 * self-tests, and 39 gestures, libraries and runners - `addmember.mjs`, whose own docblock opens
 * *"ADDING A MEMBER TO A GROUP - one gesture"*, sat under a heading announcing it as a question.
 *
 * **That is not a cosmetic mislabel, it is the exact failure this index was built to end.** A
 * session looking for an add-member gesture reads the atoms section, does not find it, and writes a
 * third one - which is what the user reported (*"tu as recode des choses qui existaient deja parce
 * que le script n'avait pas ete trouve"*). Filing a gesture under "Rows" makes it unfindable just as
 * effectively as leaving it out.
 *
 * A file is placed by what it DOES, so the heading cannot lie and cannot drift: the classification
 * is recomputed on every run and `--check` gates it.
 */
const SECTIONS = [
  {
    key: 'atoms',
    title: 'Atoms and libraries - the harness root',
    blurb:
      'One GESTURE each, or the vocabulary a gesture is built from. An atom ends on a fact rather ' +
      'than a clock, reads before it acts so a second call is a read, and addresses the product ' +
      'structurally rather than by pixel or wording. ' +
      'See [`atoms.mjs`](atoms.mjs) for the contract and the grouped inventory.',
    match: (f) => f.dir === '.' && !f.verdict,
  },
  {
    key: 'primitives-measured',
    title: 'Primitives that carry their own row',
    blurb:
      'A gesture other rows REST ON, measured by a row of its own so a failure in it is attributed ' +
      'to it rather than to everything built on top. It writes a verdict, so it is not an atom by ' +
      'the strict reading - and that is deliberate, not an accident of filing.',
    match: (f) => f.dir === '.' && f.verdict,
  },
  {
    key: 'rows',
    title: 'Rows - `archive/`',
    blurb:
      'One QUESTION each, composed of gestures, ending in a verdict in `results.ndjson`. ' +
      'See [`archive/README.md`](archive/README.md).',
    match: (f) => f.dir === 'archive' && f.verdict && !f.selftest,
  },
  {
    key: 'selftests',
    title: 'Self-tests - `archive/`',
    blurb:
      'These test the HARNESS, not the product, and record nothing: they are the gated suite ' +
      '`make test-harness` runs. A failure here means an instrument is lying, which is worse than ' +
      'a failing row.',
    match: (f) => f.selftest,
  },
  {
    key: 'archive-gestures',
    title: 'Gestures, libraries and runners in `archive/`',
    blurb:
      'They live under `archive/` but they are NOT questions - they take no verdict. Runners that ' +
      'drive other rows, probes, and vocabulary that never moved to the root. ' +
      '**Search here before writing a gesture**: this is the half that used to be filed as rows, ' +
      'where nobody looking for a gesture would ever have found it.',
    match: (f) => f.dir === 'archive' && !f.verdict && !f.selftest,
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
  // A HORIZONTAL-SPACE CLASS AND NOT `\s*` BEFORE THE OPTIONAL PREFIX, which is the bug this had.
  // `\s` matches a newline, so the first quantifier swallowed the line break and the optional
  // ` * ` group never got a chance to run - every multi-line headline was captured WITH its
  // leading asterisk and the table read `| * TURNS A BROWSER PROFILE... |`. The one-line form
  // (`shot.mjs`) was right by accident, which is why it looked like a one-off rather than the rule.
  const m = /\/\*\*[ \t]*(?:\n[ \t]*\*[ \t]*)?(.+?)[ \t]*(?:\n|\*\/)/.exec(src);
  if (!m) return null;
  // Collapse whitespace and strip the markdown emphasis these headers use, which reads as noise in
  // a table cell where every row is already a title.
  return m[1].replace(/\s+/g, ' ').replace(/\*\*/g, '').trim();
}

/**
 * Every `.mjs` GIT WILL PUT ON A FRESH CHECKOUT, in one section directory, sorted.
 *
 * IT IS `git ls-files`, NOT `readdirSync`, AND CI IS WHAT TAUGHT ME THAT. Reading the directory
 * describes MY MACHINE: `names.mjs` is gitignored - it is the machine-local pointer at the
 * out-of-tree credential store - so a listing that included it could never match on a runner, and
 * `--check` failed on CI while passing here. An index of files a fresh clone does not have is an
 * index that sends its reader to a file they cannot open, which is the whole failure this was
 * written to end. `gate-selftest.mjs` already reasons this way, for the same reason.
 */
function scan(dir) {
  const rel = dir === '.' ? '.' : dir;
  const listed = execFileSync('git', ['ls-files', '--', rel], { cwd: HERE, encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const abs = dir === '.' ? HERE : join(HERE, dir);
  // `git ls-files` answers paths relative to HERE, so `archive/x.mjs` appears in BOTH scans. Strip
  // the section's own prefix, then keep only what is directly at this level - one entry per file,
  // in exactly one section.
  const prefix = dir === '.' ? '' : `${dir}/`;
  return listed
    .filter((f) => f.endsWith('.mjs') && f.startsWith(prefix))
    .map((f) => f.slice(prefix.length))
    .filter((f) => !f.includes('/'))
    .sort()
    .map((f) => ({
      file: f,
      dir,
      name: dir === '.' ? f : `${dir}/${f}`,
      headline: headline(join(abs, f)),
      verdict: writesAVerdict(join(abs, f)),
      selftest: /selftest/.test(f),
    }));
}

/** Every script in the rig, each already carrying the two facts the sections are chosen by. */
const everything = () => [...scan('.'), ...scan('archive')];

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
    '**A script is filed by what it DOES, not by which directory it sits in.** A row writes a verdict',
    'to `results.ndjson`; everything else is a gesture, a library or a runner, wherever it lives. That',
    'distinction is recomputed on every run, so a heading here cannot go stale - and it matters,',
    'because 39 gestures under `archive/` used to be announced as questions, which is a good way to',
    'make a gesture as unfindable as leaving it out entirely.',
    '',
  ];
  const files = everything();
  const placed = new Set();
  for (const s of SECTIONS) {
    const rows = files.filter((f) => s.match(f));
    for (const r of rows) placed.add(r.name);
    parts.push(`## ${s.title}`, '', s.blurb, '', `${rows.length} script${rows.length === 1 ? '' : 's'}.`, '', '| script | what it is |', '|---|---|');
    for (const r of rows) {
      parts.push(`| \`${r.name}\` | ${cell(r.headline ?? '**NO DOCBLOCK**')} |`);
    }
    parts.push('');
  }
  // EVERY FILE LANDS IN EXACTLY ONE SECTION, ASSERTED RATHER THAN ASSUMED. The sections are
  // predicates now, so a future edit can leave a hole (a file matching none) or a double count (a
  // file matching two) without either being visible in the output - the totals would simply be
  // wrong and nobody would know which way. This is the one thing a generated index cannot be
  // allowed to get wrong, because its whole value is that a reader can trust a name is absent.
  if (placed.size !== files.length) {
    const missed = files.filter((f) => !placed.has(f.name)).map((f) => f.name);
    throw new Error(
      `the sections do not partition the tree: ${files.length} scripts, ${placed.size} placed` +
        (missed.length ? ` - unplaced: ${missed.join(', ')}` : ' - a file matched two sections'),
    );
  }
  parts.push(`---`, '', `${files.length} scripts in total.`, '');
  return parts.join('\n');
}

const wanted = render();
const check = process.argv.includes('--check');

// A script with no headline is reported by NAME rather than as a count: the point of the gate is
// that the next person knows which file to open.
const undocumented = everything()
  .filter((r) => !r.headline)
  .map((r) => r.name);

/** `62 rows, 13 self-tests, ...` - the counts the sections were chosen by, for the one-line report. */
function tally() {
  const files = everything();
  return SECTIONS.map((s) => `${files.filter((f) => s.match(f)).length} ${s.key}`).join(', ');
}

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
  console.log(`ok   INVENTORY.md matches the tree (${tally()})`);
} else {
  writeFileSync(OUT, wanted);
  console.log(`wrote INVENTORY.md - ${tally()}`);
  if (undocumented.length) {
    console.log(`NOTE ${undocumented.length} script(s) have no docblock: ${undocumented.join(', ')}`);
  }
}
