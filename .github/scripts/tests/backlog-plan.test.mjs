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
 *   3. the committed `docs/wiki/plan.md` is not byte for byte what the lines produce.
 *
 * A CONFLICT ON `plan.md` IS RESOLVED BY REGENERATING IT, never by hand: take either side, run
 * `bun tools/backlog-plan/plan.mjs`, commit.
 *
 * Usage: bun .github/scripts/tests/backlog-plan.test.mjs [repo root]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collect, PAGE, render, TIERS } from '../../../tools/backlog-plan/plan.mjs';

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

console.log('\ndocs/wiki/plan.md is what the targets produce');
const page = PAGE(ROOT);
const current = existsSync(page) ? readFileSync(page, 'utf8').replace(/\r/g, '') : '';
if (current !== render(entries)) no('docs/wiki/plan.md is stale', ['Run `bun tools/backlog-plan/plan.mjs` and commit the page.']);
else ok('the page matches');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
