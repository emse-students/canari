#!/usr/bin/env bun
/**
 * THE TEST INVENTORY: every test suite of the repository, what it guards, when it was last red, what
 * it costs, and which of them are candidates for deletion with the covering test NAMED.
 *
 *   bun tools/test-inventory/inventory.mjs                       # JSON to tools/test-inventory/out/
 *   bun tools/test-inventory/inventory.mjs --timings vitest.json # + runtime from a runner's JSON report
 *   bun tools/test-inventory/inventory.mjs --ci-red 60           # + failing CI runs' logs (gh, cached)
 *   bun tools/test-inventory/inventory.mjs --write-wiki          # regenerate the section of the wiki
 *
 * It is the FIRST step of WP-TEST-TOOLING-REFORM (docs/wiki/test-suite-reform.md) and DELETES NOTHING:
 * a candidate is a pointer for a reviewer, never a verdict. Read tools/test-inventory/README.md for how
 * each column is derived and what it cannot know.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  appImports,
  backtickedDirs,
  backtickedStems,
  hasAssertion,
  isConstantMirror,
  bodyKey,
  classifyTextReads,
  derivePurpose,
  failedPathsInLog,
  looksLikeFix,
  parseJsTests,
  parseKotlinTests,
  parseRustTests,
  parseScriptAssertions,
  snapshotCount,
  stemOf,
  touchesDom,
} from './lib.mjs';
import { DECLARED_GROUPS } from '../../.github/scripts/lib/declared-duplicates.mjs';
import { renderMarkdown } from './render.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const WIKI = join(ROOT, 'docs', 'wiki', 'test-suite-reform.md');
const BEGIN = '<!-- test-inventory:begin -->';
const END = '<!-- test-inventory:end -->';

/** @param {string[]} argv */
function parseArgs(argv) {
  const o = {
    timings: [],
    ciRed: 0,
    windowDays: 90,
    json: join(ROOT, 'tools', 'test-inventory', 'out', 'inventory.json'),
    writeWiki: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--timings') o.timings.push(argv[++i]);
    else if (a === '--ci-red') o.ciRed = Number(argv[++i]);
    else if (a === '--window-days') o.windowDays = Number(argv[++i]);
    else if (a === '--json') o.json = resolve(argv[++i]);
    else if (a === '--write-wiki') o.writeWiki = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** @param {string[]} args */
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** The suites, as [id, label, runner, predicate over a tracked path]. Order = report order. */
const SUITES = [
  [
    'frontend-vitest',
    'Frontend vitest',
    'vitest',
    (p) => /^frontend\/src\/.*\.(test|spec)\.ts$/.test(p),
  ],
  [
    'social-service',
    'social-service jest',
    'jest',
    (p) => /^apps\/social-service\/.*\.spec\.ts$/.test(p),
  ],
  [
    'chat-delivery-service',
    'chat-delivery-service jest',
    'jest',
    (p) => /^apps\/chat-delivery-service\/.*\.spec\.ts$/.test(p),
  ],
  [
    'core-service',
    'core-service jest',
    'jest',
    (p) => /^apps\/core-service\/.*\.spec\.ts$/.test(p),
  ],
  [
    'media-service',
    'media-service jest',
    'jest',
    (p) => /^apps\/media-service\/.*\.spec\.ts$/.test(p),
  ],
  [
    'rust-mls-core',
    'Rust frontend/mls-core',
    'cargo',
    (p) => /^frontend\/mls-core\/.*\.rs$/.test(p),
  ],
  [
    'rust-src-tauri',
    'Rust frontend/src-tauri',
    'cargo',
    (p) => /^frontend\/src-tauri\/(src|tests|plugins)\/.*\.rs$/.test(p),
  ],
  [
    'rust-chat-gateway',
    'Rust apps/chat-gateway',
    'cargo',
    (p) => /^apps\/chat-gateway\/.*\.rs$/.test(p),
  ],
  [
    'rust-call-service',
    'Rust apps/call-service',
    'cargo',
    (p) => /^apps\/call-service\/.*\.rs$/.test(p),
  ],
  [
    'android-unit',
    'Android unit (Kotlin)',
    'gradle',
    (p) => /^frontend\/src-tauri\/android-tests\/src\/test\/.*Test\.kt$/.test(p),
  ],
  [
    'github-scripts',
    'GitHub-script tests',
    'bun/bash',
    (p) => /^\.github\/scripts\/tests\/.*\.test\.(mjs|sh)$/.test(p),
  ],
  [
    'harness-selftests',
    'Harness self-tests',
    'bun',
    (p) => /^tools\/cross-client-harness\/archive\/[^/]*selftest[^/]*\.mjs$/.test(p),
  ],
  [
    'tools-tests',
    'tools/* tests',
    'bun',
    (p) => /^tools\/(?!cross-client-harness)[^/]+\/.*\.test\.(mjs|ts)$/.test(p),
  ],
  [
    'ecosystem-shape',
    'tools/ecosystem-shape gate',
    'bun',
    (p) => p === 'tools/ecosystem-shape/shape.mjs',
  ],
];

/** Above this many test files in one commit, the commit is not attributed to any of them. */
const MASS_COMMIT = 25;

/** Terminal colour codes in a CI log, built from the escape code so no control character is written. */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

const rel = (p) => p.replace(/\\/g, '/');

/** Map every tracked test path to the commits of the window that touched it. */
function gitWindow(days, wanted) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const out = git([
    'log',
    `--since=${since}`,
    '--no-merges',
    '--name-only',
    '--format=@@%H%x09%cs%x09%s',
  ]);
  const touches = new Map();
  let cur = null;
  let pending = [];
  const flush = () => {
    // A commit touching dozens of test files (a formatter, a rename) says nothing about any one of them.
    if (cur && pending.length <= MASS_COMMIT) for (const f of pending) touches.get(f).push(cur);
    pending = [];
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) {
      flush();
      const [sha, date, ...s] = line.slice(2).split('\t');
      cur = { sha: sha.slice(0, 9), date, subject: s.join('\t') };
    } else if (line && cur && wanted.has(line)) {
      if (!touches.has(line)) touches.set(line, []);
      pending.push(line); // newest first, as git prints
    }
  }
  flush();
  // When each file was ADDED: a test born in a fix commit was written for a defect that really happened.
  const born = new Map();
  for (const block of git([
    'log',
    '--no-renames',
    '--diff-filter=A',
    '--name-only',
    '--format=@@%H%x09%cs%x09%s',
  ]).split('@@')) {
    const [head, ...files] = block.split('\n');
    if (!head) continue;
    const [sha, date, ...subj] = head.split('\t');
    for (const f of files)
      if (f && wanted.has(f) && !born.has(f))
        born.set(f, { sha: sha.slice(0, 9), date, subject: subj.join('\t') });
  }
  return { since, touches, born };
}

/** Runtime and real case counts from vitest/jest `--json` reports, keyed by repo-relative path. */
function readTimings(files, known) {
  const byPath = new Map();
  for (const f of files) {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    for (const t of j.testResults ?? []) {
      const parts = rel(t.name).split('/');
      let hit = null;
      for (let i = 0; i < parts.length && !hit; i++) {
        const cand = parts.slice(i).join('/');
        if (known.has(cand)) hit = cand;
      }
      if (!hit) continue;
      const results = t.assertionResults ?? t.tests ?? [];
      byPath.set(hit, {
        ms: Math.round((t.endTime ?? 0) - (t.startTime ?? 0)),
        cases: results.length,
        skipped: results.filter(
          (r) => r.status === 'pending' || r.status === 'skipped' || r.status === 'todo'
        ).length,
        failed: results.filter((r) => r.status === 'failed').length,
      });
    }
  }
  return byPath;
}

/** Failing CI runs -> the test files their logs name. Cached under the OS temp dir, one file per run. */
function readCiRed(n, known) {
  const cache = join(tmpdir(), 'canari-test-inventory-ci');
  mkdirSync(cache, { recursive: true });
  const list = spawnSync(
    'gh',
    [
      'run',
      'list',
      '--workflow',
      'ci.yml',
      '--status',
      'failure',
      '--limit',
      String(n),
      '--json',
      'databaseId,createdAt,headBranch,event',
    ],
    { cwd: ROOT, encoding: 'utf8' }
  );
  if (list.status !== 0) throw new Error(`gh run list failed: ${list.stderr}`);
  const runs = JSON.parse(list.stdout);
  const byFile = new Map();
  const stats = { runs: runs.length, withNamedTest: 0, logsUnavailable: 0 };
  const bySuffix = new Map();
  for (const p of known)
    bySuffix.set(p.split('/').pop(), [...(bySuffix.get(p.split('/').pop()) ?? []), p]);
  for (const run of runs) {
    const file = join(cache, `${run.databaseId}.log`);
    if (!existsSync(file)) {
      const v = spawnSync('gh', ['run', 'view', String(run.databaseId), '--log-failed'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });
      writeFileSync(file, v.status === 0 ? v.stdout : '');
    }
    const log = readFileSync(file, 'utf8');
    if (!log) {
      stats.logsUnavailable++;
      continue;
    }
    let named = false;
    for (const named_path of failedPathsInLog(log.replace(ANSI, ''))) {
      const candidates = (bySuffix.get(named_path.split('/').pop()) ?? []).filter(
        (p) => p.endsWith(named_path) || named_path.endsWith(p) || p.endsWith(`/${named_path}`)
      );
      for (const p of candidates.length ? candidates : []) {
        let a = byFile.get(p);
        if (!a) byFile.set(p, (a = []));
        a.push({ run: run.databaseId, date: run.createdAt.slice(0, 10), branch: run.headBranch });
        named = true;
      }
    }
    if (named) stats.withNamedTest++;
  }
  const perRun = new Map();
  for (const hits of byFile.values())
    for (const h of hits) perRun.set(h.run, (perRun.get(h.run) ?? 0) + 1);
  const [bigRun, bigFiles] = [...perRun.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  stats.biggestRun = bigRun ? { run: bigRun, files: bigFiles } : null;
  return { byFile, stats };
}

/** One entry per test file. */
function inventoryFiles(tracked, window) {
  const entries = [];
  for (const [suite, , runner, pred] of SUITES) {
    for (const path of tracked.filter(pred)) {
      const abs = join(ROOT, path);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf8');
      const ext = path.split('.').pop();
      const loc = text.split('\n').length;
      let cases = 0,
        dynamicCases = 0,
        skipped = 0,
        ignored = 0,
        caseList = [],
        describes = [],
        caseNames = [];
      let unit = 'cases';
      if (ext === 'rs') {
        const r = parseRustTests(text);
        cases = r.cases;
        ignored = r.ignored;
        if (cases === 0) continue; // a Rust source file without a test is not a suite
      } else if (ext === 'kt') {
        cases = parseKotlinTests(text).cases;
      } else if (suite === 'ecosystem-shape') {
        const readme = readFileSync(join(ROOT, 'tools/ecosystem-shape/README.md'), 'utf8');
        cases = (readme.match(/^\| \d+ \|/gm) ?? []).length;
        unit = 'claims';
      } else if (
        /\.(test|spec)\.(ts)$/.test(path) ||
        path.endsWith('.test.mjs') ||
        /selftest/.test(path)
      ) {
        const r = parseJsTests(text);
        if (r.cases.length > 0 || runner === 'vitest' || runner === 'jest') {
          caseList = r.cases;
          describes = r.describes;
          cases = r.cases.length;
          dynamicCases = r.cases.filter((c) => c.dynamic).length;
          skipped = r.cases.filter((c) => c.skipped).length;
          caseNames = r.cases.map((c) => c.title);
        } else {
          cases = parseScriptAssertions(text, ext);
          unit = 'assertions';
        }
      } else {
        cases = parseScriptAssertions(text, ext);
        unit = 'assertions';
      }
      const purpose = derivePurpose(text, describes, caseNames);
      const reads =
        ext === 'rs' || ext === 'kt'
          ? { readsFiles: false, kind: 'none' }
          : classifyTextReads(text);
      const touches = window.touches.get(path) ?? [];
      const fixes = touches.filter((c) => looksLikeFix(c.subject));
      entries.push({
        path,
        suite,
        runner,
        cases,
        caseUnit: unit,
        dynamicCases,
        skippedCases: skipped,
        ignoredCases: ignored,
        loc,
        purpose: purpose.purpose,
        purposeSource: purpose.source,
        textReads: reads.kind,
        appImports: ext === 'rs' || ext === 'kt' ? null : appImports(text).length,
        touchesDom: ext === 'rs' || ext === 'kt' ? null : touchesDom(text),
        snapshots: snapshotCount(text),
        commitsInWindow: touches.length,
        lastTouch: touches[0] ?? null,
        lastFixTouch: fixes[0] ?? null,
        born: window.born.get(path) ?? null,
        bornInFix: Boolean(window.born.get(path) && looksLikeFix(window.born.get(path).subject)),
        ciRed: [],
        ms: null,
        _cases: caseList,
        _text: text,
      });
    }
  }
  return entries;
}

/** Deletion candidates, each with the covering test named or said absent. Never a verdict. */
function findCandidates(entries, t5Keep, t5Dirs) {
  const out = [];
  const byDirStem = new Map();
  for (const e of entries.filter((x) => x.suite === 'frontend-vitest')) {
    const k = `${dirname(e.path)}\u0000${stemOf(e.path)}`;
    byDirStem.set(k, [...(byDirStem.get(k) ?? []), e.path]);
  }
  // 1. Source-text tests that exercise no code: pure text, a sibling may already prove it behaviourally.
  for (const e of entries) {
    if (e.suite !== 'frontend-vitest' || e.textReads !== 'app-source') continue;
    const pure = e.appImports === 0 && !e.touchesDom;
    const siblings = (byDirStem.get(`${dirname(e.path)}\u0000${stemOf(e.path)}`) ?? []).filter(
      (p) => p !== e.path
    );
    const kept = t5Keep.has(stemOf(e.path)) || [...t5Dirs].some((d) => e.path.includes(`/${d}/`));
    e.sourceText = { pure, siblings, t5Keep: kept };
    if (!pure) continue;
    if (kept) continue;
    if (siblings.length > 0) {
      out.push({
        class: 'source-text',
        path: e.path,
        cases: e.cases,
        covering: siblings,
        confidence: 'medium',
        note: 'reads source as text, imports no app code; a sibling of the same subject exists - verify it asserts the same class',
      });
    } else {
      out.push({
        class: 'source-text',
        path: e.path,
        cases: e.cases,
        covering: [],
        confidence: 'none-found',
        note: 'reads source as text, imports no app code, no sibling test of the same stem and not on the WP-T5 keep list - needs a human reading',
      });
    }
  }
  // 1b. Declared copies: the repository itself lists the groups of files that are kept byte-identical
  // on purpose, and a gate pins them. A test of such a copy is covered by its sibling's - UNLESS it reads
  // what is installed next to it (a framework-boot spec asserts ITS service's node_modules).
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const declaredSources = new Set(DECLARED_GROUPS.flatMap((g) => g.files));
  const declaredHandled = new Set();
  for (const g of DECLARED_GROUPS) {
    const members = g.files.filter((f) => byPath.has(f));
    if (members.length < 2) continue;
    const [kept, ...rest] = members;
    for (const p of members) declaredHandled.add(p);
    for (const p of rest) {
      const e = byPath.get(p);
      if (/node_modules|installed here|require\.resolve/.test(e._text)) continue;
      const subjects = [...e._text.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)].map(
        (m) => join(dirname(p), m[1]).replace(/\\/g, '/') + '.ts'
      );
      const pinned = subjects.some((x) => declaredSources.has(x));
      out.push({
        class: 'declared-copy',
        path: p,
        cases: e.cases,
        covering: [kept, '.github/scripts/tests/declared-duplicates.test.mjs'],
        confidence: g.compare === 'exact' && pinned ? 'high' : 'medium',
        note: `byte-identical copy of ${kept.split('/').slice(0, 2).join('/')}'s test (${g.what}); its subject is ${pinned ? 'pinned identical by the gate' : 'not itself in a declared group'}`,
      });
    }
  }
  // 2. Duplicate bodies across files.
  const seen = new Map();
  for (const e of entries) {
    for (const c of e._cases) {
      const k = bodyKey(c.body);
      if (k.length < 160) continue;
      let a = seen.get(k);
      if (!a) seen.set(k, (a = []));
      a.push({ path: e.path, line: c.line, title: c.title });
    }
  }
  const dupByFile = new Map();
  for (const group of seen.values()) {
    const files = new Set(group.map((g) => g.path));
    if (files.size < 2) continue;
    for (const g of group) {
      const other = group.find((o) => o.path !== g.path);
      let a = dupByFile.get(g.path);
      if (!a) dupByFile.set(g.path, (a = []));
      a.push({ line: g.line, title: g.title, sameAs: `${other.path}:${other.line}` });
    }
  }
  for (const [path, dups] of dupByFile) {
    if (declaredHandled.has(path)) continue;
    const e = entries.find((x) => x.path === path);
    e.duplicateCases = dups.length;
    const whole = dups.length >= Math.max(1, Math.ceil(e.cases * 0.8));
    const root = (p) =>
      p.startsWith('apps/') ? p.split('/').slice(0, 2).join('/') : p.split('/')[0];
    const covering = [...new Set(dups.map((d) => d.sameAs.replace(/:\d+$/, '')))];
    if (covering.every((c) => root(c) !== root(path))) {
      out.push({
        class: 'per-service-copy',
        path,
        cases: e.cases,
        duplicateCases: dups.length,
        covering,
        confidence: 'info',
        note: `${dups.length}/${e.cases} cases are word for word the sibling service's: each tests ITS OWN copy of the code, so deleting one leaves that copy unguarded - the finding is the copied code (a shared library), not the test`,
      });
      continue;
    }
    out.push({
      class: 'duplicate-body',
      path,
      cases: e.cases,
      duplicateCases: dups.length,
      covering: [...new Set(dups.map((d) => d.sameAs.replace(/:\d+$/, '')))],
      confidence: whole ? 'high' : 'low',
      note: `${dups.length}/${e.cases} cases have a body identical (whitespace and comments aside) to a case in another file${whole ? ' - the whole file' : ''}`,
      examples: dups.slice(0, 3),
    });
  }
  // 2b. Two files of one directory that title the same cases: one of them restates the other.
  const byDir = new Map();
  for (const e of entries.filter((x) => x._cases.length >= 3))
    byDir.set(dirname(e.path), [...(byDir.get(dirname(e.path)) ?? []), e]);
  for (const group of byDir.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = new Set(group[i]._cases.map((c) => c.title).filter((t) => t.length >= 25));
        const shared = group[j]._cases.map((c) => c.title).filter((t) => a.has(t));
        const smaller = Math.min(group[i]._cases.length, group[j]._cases.length);
        if (shared.length >= 3 && shared.length >= smaller * 0.5) {
          const [small, big] =
            group[i]._cases.length <= group[j]._cases.length
              ? [group[i], group[j]]
              : [group[j], group[i]];
          out.push({
            class: 'same-titles',
            path: small.path,
            cases: small.cases,
            covering: [big.path],
            confidence: 'low',
            note: `${shared.length} of its ${small.cases} case titles are also titles in the sibling file (same directory) - compare the bodies before deleting`,
            examples: shared.slice(0, 3).map((title) => ({ title })),
          });
        }
      }
    }
  }
  // 2c. Change detectors: cases that only compare a constant to a literal.
  for (const e of entries) {
    const mirrors = e._cases.filter((c) => isConstantMirror(c.body));
    if (e.cases >= 3 && mirrors.length >= e.cases * 0.6) {
      e.constantMirrorCases = mirrors.length;
      out.push({
        class: 'constant-mirror',
        path: e.path,
        cases: e.cases,
        covering: [],
        confidence: 'low',
        note: `${mirrors.length}/${e.cases} cases only compare an imported value to a literal: they fail when the value is changed on purpose and pass when it is wrong in a way the literal copies`,
        examples: mirrors.slice(0, 3).map((c) => ({ line: c.line, title: c.title })),
      });
    }
  }
  // 3. Snapshot-only, empty, and skipped.
  for (const e of entries) {
    if (
      e.snapshots > 0 &&
      e.textReads === 'none' &&
      !/\bexpect\([^)]*\)\.(?!toMatch(Inline|File)?Snapshot)/.test(e._text)
    ) {
      out.push({
        class: 'snapshot-only',
        path: e.path,
        cases: e.cases,
        covering: [],
        confidence: 'none-found',
        note: 'every assertion is a snapshot',
      });
    }
    const hollow = e._cases.filter((c) => !c.skipped && !hasAssertion(c.body));
    if (hollow.length > 0) {
      e.hollowCases = hollow.length;
      out.push({
        class: 'no-assertion',
        path: e.path,
        cases: e.cases,
        covering: [],
        confidence: hollow.length === e.cases ? 'medium' : 'low',
        note: `${hollow.length}/${e.cases} case(s) contain no expect/assert (${hollow
          .slice(0, 2)
          .map((c) => `line ${c.line}`)
          .join(', ')}): they pass by not throwing`,
        examples: hollow.slice(0, 3).map((c) => ({ line: c.line, title: c.title })),
      });
    }
    if (e.cases === 0 && e.caseUnit === 'cases') {
      out.push({
        class: 'empty',
        path: e.path,
        cases: 0,
        covering: [],
        confidence: 'high',
        note: 'declares no case at all (an empty gate)',
      });
    }
    if (e.skippedCases > 0) {
      out.push({
        class: 'skipped',
        path: e.path,
        cases: e.cases,
        covering: [],
        confidence: 'high',
        note: `${e.skippedCases} skipped/todo case(s) assert nothing`,
      });
    }
  }
  return out;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const tracked = git(['ls-files']).split('\n').filter(Boolean).map(rel);
  const wanted = new Set(tracked.filter((p) => SUITES.some((suite) => suite[3](p))));
  const window = gitWindow(o.windowDays, wanted);
  const entries = inventoryFiles(tracked, window);
  const known = new Set(entries.map((e) => e.path));

  if (o.timings.length > 0) {
    const t = readTimings(o.timings, known);
    for (const e of entries) {
      const r = t.get(e.path);
      if (r)
        Object.assign(e, {
          ms: r.ms,
          runCases: r.cases,
          runSkipped: r.skipped,
          runFailed: r.failed,
        });
    }
  }
  let ci = null;
  if (o.ciRed > 0) {
    ci = readCiRed(o.ciRed, known);
    for (const e of entries) e.ciRed = ci.byFile.get(e.path) ?? [];
  }
  const wiki = existsSync(WIKI) ? readFileSync(WIKI, 'utf8') : '';
  const outside = wiki.includes(BEGIN)
    ? wiki.slice(0, wiki.indexOf(BEGIN)) + wiki.slice(wiki.indexOf(END) + END.length)
    : wiki;
  const t5 = outside.includes('### WP-T5')
    ? outside.slice(outside.indexOf('### WP-T5'), outside.indexOf('### WP-T6'))
    : '';
  const t5Keep = backtickedStems(t5);
  const t5Dirs = backtickedDirs(t5);
  const candidates = findCandidates(entries, t5Keep, t5Dirs);

  const suites = SUITES.map(([id, label, runner]) => {
    const es = entries.filter((e) => e.suite === id);
    const fixes = es
      .map((e) => e.lastFixTouch)
      .filter(Boolean)
      .sort((a, b) => b.date.localeCompare(a.date));
    const timed = es.filter((e) => e.ms != null);
    return {
      id,
      label,
      runner,
      files: es.length,
      cases: es.reduce((n, e) => n + e.cases, 0),
      runCases: es.some((e) => e.runCases != null)
        ? es.reduce((n, e) => n + (e.runCases ?? e.cases), 0)
        : null,
      bornInFix: es.filter((e) => e.bornInFix).length,
      caseUnit:
        es.some((e) => e.caseUnit !== 'cases') && es.some((e) => e.caseUnit === 'cases')
          ? 'mixed'
          : (es[0]?.caseUnit ?? 'cases'),
      skipped: es.reduce((n, e) => n + e.skippedCases, 0),
      ignored: es.reduce((n, e) => n + e.ignoredCases, 0),
      ms: timed.length ? timed.reduce((n, e) => n + e.ms, 0) : null,
      lastFix: fixes[0] ?? null,
      filesWithFix: es.filter((e) => e.lastFixTouch).length,
    };
  });

  const ranked = [...entries].sort((a, b) =>
    o.timings.length ? (b.ms ?? -1) - (a.ms ?? -1) : b.cases - a.cases
  );
  const byClass = {};
  const byConfidence = {};
  for (const x of candidates) {
    byClass[x.class] = (byClass[x.class] ?? 0) + 1;
    byConfidence[x.confidence] = (byConfidence[x.confidence] ?? 0) + 1;
  }
  const order = { high: 0, medium: 1, low: 2, 'none-found': 3, info: 4 };
  const listed = candidates
    .filter(
      (x) => x.class !== 'per-service-copy' && (x.covering.length > 0 || x.confidence === 'high')
    )
    .sort((a, b) => order[a.confidence] - order[b.confidence] || b.cases - a.cases);

  const inv = {
    meta: {
      date: new Date().toISOString().slice(0, 10),
      commit: git(['rev-parse', '--short=9', 'HEAD']).trim(),
      windowSince: window.since,
      windowDays: o.windowDays,
      timingsFiles: o.timings.length
        ? o.timings.map((f) => f.replace(/\\/g, '/').split('/').pop())
        : null,
      ciRedRuns: o.ciRed || null,
      ciRed: ci?.stats ?? null,
    },
    totals: {
      files: entries.length,
      cases: entries.reduce((n, e) => n + e.cases, 0),
      runCases: entries.some((e) => e.runCases != null)
        ? entries
            .filter((e) => e.suite === 'frontend-vitest')
            .reduce((n, e) => n + (e.runCases ?? e.cases), 0)
        : null,
      runFailed: entries.reduce((n, e) => n + (e.runFailed ?? 0), 0),
      bornInFix: entries.filter((e) => e.bornInFix).length,
      ciRedFiles: entries.filter((e) => e.ciRed.length > 0).length,
      dynamicCaseDecls: entries.reduce((n, e) => n + e.dynamicCases, 0),
      sourceTextFiles: entries.filter((e) => e.textReads === 'app-source').length,
      sourceTextCases: entries
        .filter((e) => e.textReads === 'app-source')
        .reduce((n, e) => n + e.cases, 0),
      purposeUnknown: entries.filter((e) => e.purposeSource === 'unknown').length,
      neverRedInWindow: entries.filter((e) => !e.lastFixTouch && e.ciRed.length === 0).length,
    },
    suites,
    top20: ranked.slice(0, 20).map(({ _cases, _text, ...e }) => e),
    candidates: {
      counts: { total: candidates.length, byClass, byConfidence },
      copies: candidates.filter((x) => x.class === 'per-service-copy'),
      hollow: entries.reduce((n, e) => n + (e.hollowCases ?? 0), 0),
      hollowFiles: entries.filter((e) => e.hollowCases).length,
      t5KeepFiles: entries.filter((e) => e.sourceText?.t5Keep).length,
      listed,
      all: candidates,
    },
    files: entries.map(({ _cases, _text, ...e }) => e),
  };

  mkdirSync(dirname(o.json), { recursive: true });
  writeFileSync(o.json, `${JSON.stringify(inv, null, 2)}\n`);
  console.log(
    `wrote ${o.json}: ${inv.totals.files} files, ${inv.totals.cases} cases, ${candidates.length} candidates`
  );

  if (o.writeWiki) {
    if (!wiki.includes(BEGIN) || !wiki.includes(END))
      throw new Error(`${WIKI} lacks the ${BEGIN} / ${END} markers`);
    const next = `${wiki.slice(0, wiki.indexOf(BEGIN) + BEGIN.length)}\n\n${renderMarkdown(inv)}\n\n${wiki.slice(wiki.indexOf(END))}`;
    writeFileSync(WIKI, next);
    console.log(`regenerated the inventory section of ${WIKI}`);
  }
}

await main();
