#!/usr/bin/env bun
/**
 * EVERY SECRET A WORKFLOW READS HAS A LEVEL, AND ITS READERS CAN SEE THAT LEVEL.
 *
 * GitHub caps a repository at 100 secrets (a PUT on the 101st answers a bare HTTP 400, 2026-11-13),
 * and an environment secret overrides a repository secret of the same name for a job that declares
 * that environment. So since 2026-11-13 a secret lives at one of three levels - the repository, the
 * `production` environment, the `development` environment, or both environments under one name -
 * and `infrastructure/MIGRATION.md` section 3 states the level of each in ONE table
 * (docs/wiki/cicd.md#where-a-secret-lives-and-why). What this asserts, from the workflows themselves:
 *
 * - every `secrets.NAME` a workflow reads is a row of that table (a new secret is born WITH its
 *   level, or this fails and names it);
 * - a secret whose level is an environment is read only by jobs that declare that environment: a
 *   job with no environment would read it EMPTY, which is a deploy that fails late or, for an
 *   optional value, a feature that is silently off;
 * - a name kept in BOTH environments under one name is exactly the list `release.yml`'s preflight
 *   refuses to find at repository level - the guard that stops an environment lacking the name from
 *   falling back to a repository copy (the other estate's value);
 * - every table row names a secret something reads, or says `none` under "read by" - a stale row is
 *   a level nobody can check.
 *
 * Text slicing, no YAML parser: a job is the block under `jobs:` at two spaces of indentation, and
 * its environment is the `environment:` key at four. Comment lines are ignored.
 *
 * Usage: bun .github/scripts/tests/secret-levels.test.mjs   (no arguments, no network)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workflowsDir = resolve(repoRoot, '.github/workflows');
const migration = readFileSync(resolve(repoRoot, 'infrastructure/MIGRATION.md'), 'utf8');

let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => {
  console.log(`  FAIL ${m}`);
  failures += 1;
};

const LEVELS = new Set(['repo', 'production', 'development', 'production, development']);

/** The table of section 3: `| \`NAME\` | level | read by |`, between its two markers. */
function readTable() {
  const start = migration.indexOf('<!-- secret-levels:start -->');
  const end = migration.indexOf('<!-- secret-levels:end -->');
  if (start === -1 || end === -1 || end < start) {
    bad('infrastructure/MIGRATION.md has no `<!-- secret-levels:start -->` ... `end` table');
    process.exit(1);
  }
  const rows = new Map();
  for (const line of migration.slice(start, end).split('\n')) {
    const m = line.match(/^\|\s*`([A-Z0-9_]+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/);
    if (!m) continue;
    const [, name, level, readBy] = m;
    if (rows.has(name)) bad(`MIGRATION.md lists ${name} twice`);
    rows.set(name, { level, readBy });
  }
  return rows;
}

/** Every job of every workflow: its file, its name, the environments it may resolve, its reads. */
function readJobs() {
  const jobs = [];
  for (const file of readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))) {
    const text = readFileSync(resolve(workflowsDir, file), 'utf8');
    const at = text.indexOf('\njobs:\n');
    if (at === -1) continue;
    const lines = text
      .slice(at + 7)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l));
    let current = null;
    let inEnv = false;
    for (const line of lines) {
      const head = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
      if (head) {
        current = { file, job: head[1], envText: '', reads: new Set() };
        jobs.push(current);
        inEnv = false;
        continue;
      }
      if (!current) continue;
      if (/^ {4}environment:/.test(line)) {
        inEnv = true;
        current.envText += line;
        continue;
      }
      if (inEnv && /^ {6}/.test(line)) current.envText += line;
      else inEnv = false;
      for (const m of line.matchAll(/secrets\.([A-Z0-9_]+)/g)) {
        if (m[1] !== 'GITHUB_TOKEN') current.reads.add(m[1]);
      }
    }
  }
  for (const j of jobs) {
    const envs = new Set();
    if (/\bproduction\b/.test(j.envText)) envs.add('production');
    if (/\bdevelopment\b/.test(j.envText)) envs.add('development');
    j.envs = envs;
  }
  return jobs;
}

const table = readTable();
const jobs = readJobs();

console.log('\nevery secret a workflow reads has a level in MIGRATION.md');
const readers = new Map();
for (const j of jobs) {
  for (const name of j.reads) {
    if (!readers.has(name)) readers.set(name, []);
    readers.get(name).push(j);
  }
}
for (const [name, js] of [...readers].sort()) {
  const row = table.get(name);
  const where = js.map((j) => `${j.file} :: ${j.job}`).join(', ');
  if (!row) {
    bad(`${name} is read by ${where} and has no row in MIGRATION.md's secret-levels table`);
    continue;
  }
  if (!LEVELS.has(row.level)) {
    bad(`${name}'s level is "${row.level}", not one of: ${[...LEVELS].join(' | ')}`);
    continue;
  }
  if (row.level === 'repo') {
    ok(`${name} (repo) - any job can read it`);
    continue;
  }
  const wanted = row.level.split(', ');
  // The preflight reads the names kept in both environments ON PURPOSE, from no environment, to
  // prove the repository holds none of them - its own group below checks that step.
  const isGuard = (j) => j.file === 'release.yml' && j.job === 'preflight' && row.level === 'production, development';
  const blind = js.filter((j) => !isGuard(j) && !wanted.some((e) => j.envs.has(e)));
  if (blind.length === 0) ok(`${name} (${row.level}) is read only by jobs that declare it`);
  else
    bad(
      `${name} lives in ${row.level} but ${blind.map((j) => `${j.file} :: ${j.job}`).join(', ')} declares no such environment - it would read the secret EMPTY`,
    );
}

console.log('\nevery row names a secret something reads');
for (const [name, row] of table) {
  if (readers.has(name)) continue;
  if (/^none\b/i.test(row.readBy)) ok(`${name} is read by no workflow, and its row says so`);
  else bad(`${name} has a row in MIGRATION.md but no workflow reads it - delete the row, or say "none" and why`);
}

console.log('\nthe names kept in both environments are the names the preflight refuses at repository level');
const both = [...table].filter(([, r]) => r.level === 'production, development').map(([n]) => n).sort();
const release = readFileSync(resolve(workflowsDir, 'release.yml'), 'utf8');
const stepAt = release.indexOf('- name: No estate secret is kept at repository level');
if (stepAt === -1) {
  bad("release.yml's preflight has no step `No estate secret is kept at repository level`");
} else {
  const step = release.slice(stepAt, release.indexOf('\n      - name:', stepAt + 1));
  const loop = step.match(/for name in ([A-Z0-9_ ]+); do/);
  const guarded = loop ? loop[1].trim().split(/\s+/).sort() : [];
  const passed = [...step.matchAll(/^ {10}([A-Z0-9_]+): \$\{\{ secrets\.\1 \}\}$/gm)].map((m) => m[1]).sort();
  if (JSON.stringify(guarded) === JSON.stringify(both)) ok(`the guard loops over exactly: ${both.join(' ')}`);
  else bad(`the guard loops over [${guarded.join(' ')}] but MIGRATION.md keeps [${both.join(' ')}] in both environments`);
  if (JSON.stringify(passed) === JSON.stringify(both)) ok('and passes each of them to the step under its own name');
  else bad(`the guard step passes [${passed.join(' ')}], not [${both.join(' ')}]`);
  if (/^ {4}environment:/m.test(release.slice(release.indexOf('\n  preflight:'), stepAt)))
    bad('the preflight job declares an environment - it would see the environment copy and prove nothing');
  else ok('the preflight job declares no environment, so it sees only the repository level');
}

console.log('');
if (failures > 0) {
  console.log(`${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('all assertions passed');
