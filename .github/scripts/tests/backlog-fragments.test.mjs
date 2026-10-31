#!/usr/bin/env bun
/**
 * A NEW BACKLOG ENTRY IS ITS OWN FILE IN `docs/wiki/backlog.d/`, NEVER A NEW HEADING IN `backlog.md`.
 *
 * WHY. `docs/wiki/backlog.md` was the one file nearly every feature pull request edited: 47 of the
 * 130 commits on `main` between 2026-10-27 and 2026-10-30 touched it, and two pull requests adding
 * an entry at the same place conflict, which blocks the automatic merge until somebody rebases. It
 * is the `changelog.d/` problem again (docs/wiki/cicd.md, "Notable CI gotchas"), and the same answer:
 * a file per entry leaves no shared line to conflict on. Nothing folds the fragments back - a fold
 * would recreate the shared file and conflict with every open pull request editing a fragment - so
 * the backlog IS `backlog.md` plus the directory, read together.
 *
 * WHAT IS ASSERTED.
 *   1. Every fragment is ONE entry: a kebab-case `.md` name, a first line that is a `## ` heading,
 *      and no second `## ` heading (two entries in one file is two items sharing lines again).
 *   2. `backlog.md` gains no heading. Every `## ` / `### ` heading in it must be one of the headings
 *      it carried when the directory was introduced, frozen in `backlog-legacy-headings.txt`. An
 *      entry is deleted when it ships (the list does not have to follow), and an entry RETITLED or
 *      ADDED fails here: move it to a fragment instead. The list only ever loses lines; adding one
 *      to pass this test is the conflict this test exists to remove.
 *   3. `backlog-closed.test.mjs` reads the fragments too, so a shipped entry cannot hide in one.
 *
 * Usage: bun .github/scripts/tests/backlog-fragments.test.mjs [repo root]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const BACKLOG = join(ROOT, 'docs', 'wiki', 'backlog.md');
const DIR = join(ROOT, 'docs', 'wiki', 'backlog.d');
const FROZEN = join(ROOT, '.github', 'scripts', 'tests', 'backlog-legacy-headings.txt');

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const no = (msg, details = []) => {
  failures++;
  console.error(`  FAIL  ${msg}`);
  for (const d of details) console.error(`          ${d}`);
};

/**
 * The `## ` and `### ` heading lines of a markdown text, outside fenced blocks (a fence can quote
 * anything, a log line or another file's heading). Trailing whitespace is not part of a heading.
 * @param {string} text
 * @returns {{ line: string, n: number }[]}
 */
function entryHeadings(text) {
  const out = [];
  let inFence = false;
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && /^###? /.test(line)) out.push({ line, n: i + 1 });
  }
  return out;
}

console.log('\nevery fragment in docs/wiki/backlog.d/ is exactly one entry');
if (!existsSync(DIR)) {
  no('docs/wiki/backlog.d/ does not exist - new entries have nowhere to go');
} else {
  const files = readdirSync(DIR).filter((f) => f !== 'README.md');
  const bad = [];
  for (const f of files) {
    if (!/^[a-z0-9][a-z0-9-]*\.md$/.test(f)) {
      bad.push(`${f}: name it in kebab-case, ending in .md`);
      continue;
    }
    const text = readFileSync(join(DIR, f), 'utf8');
    if (!text.startsWith('## ')) bad.push(`${f}: must start with a '## ' heading (the entry's title)`);
    const tops = entryHeadings(text).filter(({ line }) => line.startsWith('## '));
    if (tops.length > 1) bad.push(`${f}: holds ${tops.length} entries - one file per entry`);
  }
  if (bad.length) no('a fragment is not one entry', bad);
  else ok(`${files.length} fragment(s), each one entry with a '## ' title`);
  if (!existsSync(join(DIR, 'README.md'))) no('docs/wiki/backlog.d/README.md is missing - it is the rule');
}

console.log('\nbacklog.md gains no heading - a new or retitled entry is a fragment');
const frozen = new Set(
  readFileSync(FROZEN, 'utf8')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter(Boolean)
);
const added = entryHeadings(readFileSync(BACKLOG, 'utf8')).filter(({ line }) => !frozen.has(line));
if (added.length) {
  no(
    `${added.length} heading(s) in backlog.md that it did not carry when backlog.d/ was introduced`,
    [
      ...added.map(({ line, n }) => `backlog.md:${n}: ${line.slice(0, 110)}`),
      'Move the entry to its own file, docs/wiki/backlog.d/<what-it-is>.md (see its README).',
      'Do NOT add the heading to backlog-legacy-headings.txt: that list only ever loses lines.',
    ]
  );
} else {
  ok(`every heading in backlog.md is a legacy one (${frozen.size} frozen)`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
