import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * NOTHING CHECKS MARKDOWN, AND TWICE A MERGE HAS SHIPPED SOMETHING NOBODY WROTE.
 *
 * `bun run check` reads TypeScript and Svelte. The documentation - which is where this project keeps
 * its queue, its decisions and its history - is read by nothing at all, so a bad three-way merge in
 * it is caught by a human noticing or not caught. Both failure modes have happened:
 *
 * 1. **Conflict markers were pushed to #560.** A resolver script's assertion failed, the `git commit`
 *    on the following line ran anyway, and `<<<<<<<` reached a pull request.
 * 2. **A shipped backlog entry came back, then doubled.** `/admin`'s naming item was deleted by #565
 *    when it shipped; #564's rebase resurrected it, and #563's rebase then produced TWO copies. Git
 *    is right to do this - "they deleted entry A, we deleted entry B" is a union in adjacent text -
 *    which is exactly why the answer is a gate rather than more care.
 *
 * The user's rule for the backlog is that it holds what is LEFT, never the history
 * (*"le backlog ne doit contenir que ce qui reste a faire, pas des artefacts"*). A duplicated heading
 * is the mechanical signature of that rule being broken by a merge, so it is the thing asserted.
 *
 * **This lives in the frontend suite because that is where repo-walking guards already live** -
 * `serverProse.test.ts` walks `src/`, `iosCallDeclarations.test.ts` walks `src-tauri/` - and because
 * it is the suite CI runs on every pull request. A guard nothing runs is a guard that does not exist.
 */
const ROOT = resolve(process.cwd(), '..');

/** Every `.md` under a directory, recursively, as repo-relative paths. */
function markdownUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...markdownUnder(full));
    else if (name.endsWith('.md')) out.push(relative(ROOT, full).split('\\').join('/'));
  }
  return out;
}

/** The prose a human maintains, as opposed to anything generated. */
const TRACKED = [
  'CLAUDE.md',
  'CHANGELOG.md',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  ...markdownUnder(join(ROOT, 'docs')),
];

const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('the documentation carries no merge artefact', () => {
  it('is looking at the files it thinks it is', () => {
    // The self-check every guard here owes: a list that quietly went empty would pass everything.
    expect(TRACKED.length).toBeGreaterThan(40);
    expect(TRACKED).toContain('docs/wiki/backlog.md');
    expect(TRACKED).toContain('docs/wiki/durable-rules.md');
  });

  it.each(TRACKED)('%s has no conflict marker', (file) => {
    const offending = read(file)
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^(<{7}|={7}|>{7})(\s|$)/.test(line))
      .map(({ line, n }) => `${file}:${n}: ${line}`);

    expect(offending).toEqual([]);
  });
});

describe('the backlog holds what is LEFT, and a duplicate heading says a merge disagreed', () => {
  /** Every ATX heading in the file, with the line it sits on. */
  function headings(file: string): { text: string; n: number }[] {
    return read(file)
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /^#{2,4} /.test(line))
      .map(({ line, n }) => ({ text: line.trim(), n }));
  }

  it('finds the headings it is meant to police', () => {
    expect(headings('docs/wiki/backlog.md').length).toBeGreaterThan(50);
  });

  it('has no heading twice in docs/wiki/backlog.md', () => {
    // An entry is written once, by hand, and deleted the day it ships. Two identical headings is
    // never a choice somebody made - it is a resolution that kept both sides of a deletion.
    const seen = new Map<string, number>();
    const duplicates: string[] = [];
    for (const { text, n } of headings('docs/wiki/backlog.md')) {
      const first = seen.get(text);
      if (first !== undefined)
        duplicates.push(`backlog.md:${n} repeats the heading from :${first}`);
      else seen.set(text, n);
    }

    expect(duplicates).toEqual([]);
  });
});

describe('the changelog files work under the version that shipped it', () => {
  /**
   * WHY THIS IS NOT THE BACKLOG CHECK AGAIN.
   *
   * Every entry is added immediately under `## [Unreleased]`, and a release bump inserts
   * `## [X.Y.Z] - DATE` at that exact line. So a branch written before a release and rebased after
   * one has its entries and that new heading competing for one position, and git resolves it as a
   * union WITHOUT A CONFLICT: the entries land BELOW the heading, filed under a version that was
   * cut before they existed. Moving the heading back by hand then leaves a second copy of it, which
   * is what happened on 2026-09-24 - `## [0.18.22]` appeared twice, one rebase apart, silently.
   *
   * Neither half can be caught by reading the diff, because the diff of a clean rebase shows the
   * hunk applying exactly as written. What can be asserted is the SHAPE the file must always have:
   * `[Unreleased]` on top, every version once, and the versions descending. A rebase that files
   * work under the wrong heading breaks one of the three or it moved nothing.
   */
  const VERSION = /^## \[(\d+)\.(\d+)\.(\d+)\] - \d{4}-\d{2}-\d{2}$/;

  const releaseHeadings = () =>
    read('CHANGELOG.md')
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line.startsWith('## '));

  it('finds the headings it is meant to police', () => {
    const all = releaseHeadings();
    expect(all.length).toBeGreaterThan(20);
    expect(all[0]?.line).toBe('## [Unreleased]');
    expect(all.filter(({ line }) => line === '## [Unreleased]')).toHaveLength(1);
  });

  it('keeps [Unreleased] empty - an entry is a file in changelog.d/', () => {
    // Every pull request writing under this one heading is what made any two of them conflict, and
    // GitHub ignores the `merge=union` driver meant to absorb it. See changelog.d/README.md.
    const lines = read('CHANGELOG.md').split('\n');
    const start = lines.findIndex((line) => line.trim() === '## [Unreleased]');
    const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
    const written = lines
      .slice(start + 1, end)
      .map((line, i) => ({ line: line.trim(), n: start + 2 + i }))
      .filter(({ line }) => line !== '')
      .map(({ line, n }) => `CHANGELOG.md:${n}: ${line} - move it to a file in changelog.d/`);

    expect(written).toEqual([]);
  });

  it('gives every changelog.d/ entry a heading the release notes can carry', () => {
    // The bump pastes each fragment under `## [X.Y.Z]` verbatim, so a fragment that does not open
    // with its own `### ` heading would run into the entry before it.
    const dir = join(ROOT, 'changelog.d');
    const fragments = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
    const malformed = fragments
      .filter((f) => !/^### \S/.test(readFileSync(join(dir, f), 'utf8')))
      .map((f) => `changelog.d/${f}: must start with a '### ' heading`);

    expect(malformed).toEqual([]);
  });

  it('gives every release heading the one shape the bump writes', () => {
    // A heading that parses as neither is a heading this guard would otherwise skip in silence.
    const malformed = releaseHeadings()
      .slice(1)
      .filter(({ line }) => !VERSION.test(line))
      .map(({ line, n }) => `CHANGELOG.md:${n}: ${line}`);

    expect(malformed).toEqual([]);
  });

  it('names each version once, in descending order', () => {
    const versions = releaseHeadings()
      .slice(1)
      .map(({ line, n }) => {
        const [, major, minor, patch] = VERSION.exec(line) ?? [];
        return { line, n, rank: [Number(major), Number(minor), Number(patch)] as const };
      });

    const disordered: string[] = [];
    for (let i = 1; i < versions.length; i++) {
      const previous = versions[i - 1]!;
      const current = versions[i]!;
      const descends = previous.rank.findIndex((part, k) => part !== current.rank[k]!);
      // -1 = the same version twice; otherwise the first differing part must be the LARGER one.
      if (descends === -1 || previous.rank[descends]! < current.rank[descends]!)
        disordered.push(`CHANGELOG.md:${current.n}: ${current.line} follows ${previous.line}`);
    }

    expect(disordered).toEqual([]);
  });
});
