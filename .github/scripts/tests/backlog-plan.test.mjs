#!/usr/bin/env bun
/**
 * EVERY BACKLOG ENTRY NAMES THE VERSION IT IS PLANNED FOR, AND THE PLAN PAGE IS WHAT THOSE LINES SAY.
 *
 * WHY. The owner, 2026-11-13: every entry of the backlog is planned on a version, and the plan is
 * amended in the same pull request that adds an entry. A plan kept by hand beside the entries was
 * the roadmap's annexes: stale the day after. So each fragment of `docs/wiki/backlog.d/` carries
 * `target: <version>` under its title, `tools/backlog-plan/plan.mjs` derives `docs/wiki/plan.md`
 * from those lines, and this test fails when:
 *   1. a fragment has no `target:` line, or one naming a version outside `TIERS` (the one place
 *      the allowed set is written - every tier a real version number, no `later`);
 *   2. a reading (`Reading owed - ` title) targets anything but the earliest version;
 *   3. the page `render()` produces does not list every entry exactly once, under its own version,
 *      or loses the `Readings owed` anchor the wiki links to while readings exist;
 *   4. `docs/wiki/plan.md` is TRACKED. It is generated where it is read and gitignored
 *      (2026-11-21): committed, it made every open pull request conflict with every merge, because
 *      two pull requests filing a new entry each insert at the same line of it. A page nobody
 *      commits cannot be stale in git, and cannot conflict. docs/wiki/cicd.md, "The plan page is
 *      generated where it is read".
 *
 * Usage: bun .github/scripts/tests/backlog-plan.test.mjs [repo root]
 */
import { execFileSync } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';
import { collect, PAGE, READING_PREFIX, render, TIERS } from '../../../tools/backlog-plan/plan.mjs';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const no = (m, details = []) => {
  failures++;
  console.error(`  FAIL  ${m}`);
  for (const d of details) console.error(`          ${d}`);
};

console.log('\nevery backlog entry names a planned version');
const { entries, problems } = collect(ROOT);
if (problems.length) no(`${problems.length} entr(ies) without a valid target`, problems);
else ok(`${entries.length} entries, each targeting one of ${TIERS.join(', ')}`);

console.log('\nthe generated page lists every entry once, under its version');
const page = render(entries);
const sections = new Map();
let tier = null;
for (const line of page.split('\n')) {
  const heading = /^## (\S+)$/.exec(line);
  if (heading) tier = heading[1];
  const link = /^- .*\]\(backlog\.d\/([^)]+)\)$/.exec(line);
  if (link) sections.set(link[1], [...(sections.get(link[1]) ?? []), tier]);
}
const misplaced = entries
  .filter((e) => e.target)
  .filter((e) => (sections.get(e.file) ?? []).join() !== e.target)
  .map((e) => `${e.file}: targets ${e.target}, listed under ${(sections.get(e.file) ?? ['nothing']).join(' and ')}`);
if (misplaced.length) no(`${misplaced.length} entr(ies) missing, doubled or misplaced on the page`, misplaced);
else ok(`${sections.size} entries listed, each once, under the version it targets`);
const readings = entries.some((e) => e.title.startsWith(READING_PREFIX));
if (readings && !/^### Readings owed$/m.test(page)) no('readings exist and the page has no `### Readings owed` heading - every `plan.md#readings-owed` link is dead');
else ok(readings ? 'the `Readings owed` anchor is there' : 'no reading, so no `Readings owed` anchor is owed');

console.log('\ndocs/wiki/plan.md is generated where it is read, never committed');
const rel = relative(ROOT, PAGE(ROOT)).split(sep).join('/');
try {
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, stdio: 'ignore' });
} catch {
  console.error('FAIL this check needs a git checkout (it asks git whether plan.md is tracked and ignored); run it inside the repository, not an export');
  process.exit(1);
}
const tracked = execFileSync('git', ['ls-files', '--', rel], { cwd: ROOT, encoding: 'utf8' }).trim();
if (tracked) no(`${rel} is tracked`, ['Every merge would make every open pull request conflict on it again: `git rm --cached` it.']);
else ok(`${rel} is not tracked`);
let ignored = true;
try {
  execFileSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: ROOT });
} catch {
  ignored = false;
}
if (!ignored) no(`${rel} is not gitignored`, ['A generated page would sit in `git status` of every checkout, one `git add -A` from being committed.']);
else ok(`${rel} is gitignored`);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
