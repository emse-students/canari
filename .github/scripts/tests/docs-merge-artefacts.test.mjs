#!/usr/bin/env bun
/**
 * NOTHING CHECKS MARKDOWN, AND TWICE A MERGE HAS SHIPPED SOMETHING NOBODY WROTE.
 *
 * `bun run check` reads TypeScript and Svelte. The documentation - where this project keeps its
 * queue, its decisions and its history - is read by nothing else, so a bad three-way merge in it is
 * caught by a human noticing or not caught. Both failure modes have happened:
 *
 * 1. **Conflict markers were pushed to #560.** A resolver script's assertion failed, the `git commit`
 *    on the following line ran anyway, and `<<<<<<<` reached a pull request.
 * 2. **A shipped backlog entry came back, then doubled** (#563-#565): git is right to resolve
 *    "they deleted entry A, we deleted entry B" as a union, which is why the answer is a gate.
 *
 * A duplicated heading in `backlog.md` is the mechanical signature of a merge having disagreed, and
 * `CHANGELOG.md` has its own shape (`[Unreleased]` on top and EMPTY, every version once, descending,
 * every `changelog.d/` fragment opening with `### `).
 *
 * WHY THIS IS HERE AND NOT IN THE FRONTEND SUITE (it was `frontend/src/lib/docsMergeArtefacts.test.ts`
 * until WP-T2, docs/wiki/test-suite-reform.md): the frontend job is skipped by `changes` on a pull
 * request that touches only `docs/` or `changelog.d/` - exactly the pull request this guards. This
 * recipe, `test-ci-scripts`, runs on every pull request. A guard that does not run on the change
 * it exists for does not exist.
 *
 * Usage: bun .github/scripts/tests/docs-merge-artefacts.test.mjs [repoRoot]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));

let failures = 0;
const check = (name, offenders) => {
  if (offenders.length === 0) return console.log(`  ok   ${name}`);
  failures += 1;
  console.log(`  FAIL ${name}`);
  for (const o of offenders) console.log(`         ${o}`);
};
const assert = (name, condition) => check(name, condition ? [] : ['the self-check failed']);

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** The prose a human maintains, as opposed to anything generated: tracked markdown only. */
const TRACKED = [
  'CLAUDE.md',
  'CHANGELOG.md',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  ...execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--', 'docs'], { maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter((f) => f.endsWith('.md')),
];

console.log('the documentation carries no merge artefact:');

// The self-check every guard here owes: a list that quietly went empty would pass everything.
assert(
  'is looking at the files it thinks it is',
  TRACKED.length > 40 &&
    TRACKED.includes('docs/wiki/backlog.md') &&
    TRACKED.includes('docs/wiki/durable-rules.md')
);

check(
  'no tracked markdown file holds a conflict marker',
  TRACKED.flatMap((file) =>
    read(file)
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^(<{7}|={7}|>{7})(\s|$)/.test(line))
      .map(({ line, n }) => `${file}:${n}: ${line}`)
  )
);

console.log('the backlog holds what is LEFT, and a duplicate heading says a merge disagreed:');

const backlogHeadings = read('docs/wiki/backlog.md')
  .split('\n')
  .map((line, i) => ({ text: line.trim(), n: i + 1 }))
  .filter(({ text }) => /^#{2,4} /.test(text));

assert('finds the headings it is meant to police', backlogHeadings.length > 50);

{
  // An entry is written once, by hand, and deleted the day it ships. Two identical headings is
  // never a choice somebody made - it is a resolution that kept both sides of a deletion.
  const seen = new Map();
  const duplicates = [];
  for (const { text, n } of backlogHeadings) {
    const first = seen.get(text);
    if (first !== undefined) duplicates.push(`backlog.md:${n} repeats the heading from :${first}`);
    else seen.set(text, n);
  }
  check('no heading twice in docs/wiki/backlog.md', duplicates);
}

console.log('the changelog files work under the version that shipped it:');

const VERSION = /^## \[(\d+)\.(\d+)\.(\d+)\] - \d{4}-\d{2}-\d{2}$/;
const changelogLines = read('CHANGELOG.md').split('\n');
// Every entry used to go under `## [Unreleased]`, which is the exact line a release bump inserts
// `## [X.Y.Z]` at, so a rebase across a release filed work under a version cut before it existed
// with NO conflict. What can be asserted is the SHAPE the file must always have.
const releaseHeadings = changelogLines
  .map((line, i) => ({ line: line.trim(), n: i + 1 }))
  .filter(({ line }) => line.startsWith('## '));

assert(
  'finds the headings it is meant to police, [Unreleased] on top and once',
  releaseHeadings.length > 20 &&
    releaseHeadings[0]?.line === '## [Unreleased]' &&
    releaseHeadings.filter(({ line }) => line === '## [Unreleased]').length === 1
);

{
  const start = changelogLines.findIndex((line) => line.trim() === '## [Unreleased]');
  const end = changelogLines.findIndex((line, i) => i > start && line.startsWith('## '));
  check(
    'keeps [Unreleased] empty - an entry is a file in changelog.d/',
    changelogLines
      .slice(start + 1, end)
      .map((line, i) => ({ line: line.trim(), n: start + 2 + i }))
      .filter(({ line }) => line !== '')
      .map(({ line, n }) => `CHANGELOG.md:${n}: ${line} - move it to a file in changelog.d/`)
  );
}

{
  // The bump pastes each fragment under `## [X.Y.Z]` verbatim, so a fragment that does not open
  // with its own `### ` heading would run into the entry before it.
  const dir = join(ROOT, 'changelog.d');
  const fragments = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  check(
    'gives every changelog.d/ entry a heading the release notes can carry',
    fragments
      .filter((f) => !/^### \S/.test(readFileSync(join(dir, f), 'utf8')))
      .map((f) => `changelog.d/${f}: must start with a '### ' heading`)
  );
}

check(
  'gives every release heading the one shape the bump writes',
  releaseHeadings
    .slice(1)
    .filter(({ line }) => !VERSION.test(line))
    .map(({ line, n }) => `CHANGELOG.md:${n}: ${line}`)
);

{
  const versions = releaseHeadings.slice(1).map(({ line, n }) => {
    const [, major, minor, patch] = VERSION.exec(line) ?? [];
    return { line, n, rank: [Number(major), Number(minor), Number(patch)] };
  });
  const disordered = [];
  for (let i = 1; i < versions.length; i++) {
    const previous = versions[i - 1];
    const current = versions[i];
    const differs = previous.rank.findIndex((part, k) => part !== current.rank[k]);
    // -1 = the same version twice; otherwise the first differing part must be the LARGER one.
    if (differs === -1 || previous.rank[differs] < current.rank[differs])
      disordered.push(`CHANGELOG.md:${current.n}: ${current.line} follows ${previous.line}`);
  }
  check('names each version once, in descending order', disordered);
}

console.log(
  failures === 0 ? '\nOK: no merge artefact in the documentation.' : `\nFAIL: ${failures} check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
