#!/usr/bin/env bun
/**
 * A DUPLICATE NOBODY DECIDED ON IS THE DEFECT THAT PRODUCED BOTH CALENDAR BUGS OF 2026-09-16.
 *
 * `declared-duplicates.test.mjs` guards the copies this repository keeps ON PURPOSE. It is blind
 * to the ones that simply happened, and those are the dangerous half: nothing names them, so a
 * fix reaches whichever copy the author was looking at and the others keep the old behaviour,
 * silently, for as long as nobody opens them.
 *
 * That is not a hypothesis. On 2026-09-16 the rule "a day ends at 05:00" was written, tested and
 * merged into `feedEvents.eventCoversDay` - and `MonthCalendarGridRich.svelte` and
 * `calendarExport.ts` each carried a PRIVATE copy of "which day does this event belong to" still
 * cutting at midnight. The change reached one of the three surfaces. The month grid and the PDF,
 * the two things anyone actually looks at, kept drawing the defect the fix was written for, and
 * every test was green.
 *
 * SO THIS GATE FINDS FUNCTION BODIES THAT APPEAR, IDENTICAL ONCE NORMALISED, IN MORE THAN ONE
 * FILE, and fails on any group that is neither a declared duplicate nor an acknowledged idiom.
 * It does not ask whether the copies AGREE - they do, that is how it found them. It asks whether
 * anybody decided there should be two.
 *
 * WHAT IT CANNOT SEE, stated so nobody mistakes a green run for a proof: it compares whole
 * function bodies after trimming, so two copies that drifted by one character are invisible to it
 * (`declared-duplicates` is the gate for known copies, and nothing watches unknown ones that have
 * already diverged - which is the state today's defect was IN). It reads `.ts` and `.svelte` under
 * `frontend/src` and under `apps`, skips tests and generated trees, and ignores bodies shorter
 * than MIN_BODY_LINES normalised lines.
 *
 * TO SILENCE A GROUP: add it to `DECLARED_GROUPS` (they must agree, and the other gate then
 * enforces that) or to `ACKNOWLEDGED_IDIOMS` (their agreeing means nothing) in
 * `.github/scripts/lib/declared-duplicates.mjs` - with a `why`, in both cases. There is no
 * third disposition, because "we know" that is written nowhere is exactly what this exists to
 * refuse.
 *
 * Usage: bun .github/scripts/tests/undeclared-duplicates.test.mjs   (no arguments, no network)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ACKNOWLEDGED_IDIOMS, DECLARED_GROUPS } from '../lib/declared-duplicates.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Scanned in ONE pass, so a body shared between the client and a service is seen as one group. */
const ROOTS = ['frontend/src', 'apps'];

/**
 * Bodies shorter than this are shapes, not decisions.
 *
 * FOUR, not five, and the difference is the whole point: the only thing four catches that five
 * does not, today, is the long-press timer clear - and that group is acknowledged BY NAME with a
 * reason. A threshold chosen so the one awkward case falls below it silences that case without
 * anybody reading it, and silences every future one that happens to be the same length.
 */
const MIN_BODY_LINES = 4;

/** Generated trees, build output, and tests - a test repeating its own setup is not this defect. */
const SKIP = /node_modules|\.svelte-kit|\/build\/|\/dist\/|paraglide|\/wasm\/|\/proto\/|\.test\.|\.spec\./;

/** Every file the gate reads, repo-relative and forward-slashed on every platform. */
function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (SKIP.test(full.replace(/\\/g, '/'))) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|svelte)$/.test(name)) out.push(relative(repoRoot, full).replace(/\\/g, '/'));
    }
  };
  walk(resolve(repoRoot, root));
  return out;
}

/** Comments gone: two copies that introduce themselves differently are still two copies. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** `function name(`, `const name = (`, `const name = async (` - declarations, not call sites. */
const DECLARATION =
  /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*[(<]|(?:const|let)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g;

/**
 * Every function body in one file, hashed on its normalised text.
 *
 * Brace balance rather than a parser: this must run with no dependency beyond bun's stdlib, and an
 * unbalanced body is skipped rather than guessed at. A missed body is a gap in the gate, which is
 * honest; a wrongly delimited one would be a false failure, which would get the gate disabled.
 */
function bodiesIn(file) {
  const source = stripComments(readFileSync(resolve(repoRoot, file), 'utf8'));
  const found = [];
  DECLARATION.lastIndex = 0;
  let match;
  while ((match = DECLARATION.exec(source))) {
    const name = match[1] ?? match[2];
    const open = source.indexOf('{', match.index);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) continue;
    const normalised = source
      .slice(open + 1, end)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
    const lines = normalised.split('\n').length;
    if (!normalised || lines < MIN_BODY_LINES) continue;
    found.push({ name, lines, hash: createHash('sha1').update(normalised).digest('hex') });
  }
  return found;
}

/** A group is silenced only when EVERY file in it sits inside one declared or acknowledged set. */
function dispositionFor(files) {
  for (const group of DECLARED_GROUPS) {
    if (files.every((f) => group.files.includes(f))) return { kind: 'declared', group };
  }
  for (const idiom of ACKNOWLEDGED_IDIOMS) {
    if (files.every((f) => idiom.files.includes(f))) return { kind: 'idiom', group: idiom };
  }
  return null;
}

const byHash = new Map();
for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    for (const body of bodiesIn(file)) {
      if (!byHash.has(body.hash)) byHash.set(body.hash, []);
      byHash.get(body.hash).push({ ...body, file });
    }
  }
}

const undeclared = [];
let declaredHits = 0;
let idiomHits = 0;

for (const hits of byHash.values()) {
  const files = [...new Set(hits.map((h) => h.file))].sort();
  if (files.length < 2) continue;
  const disposition = dispositionFor(files);
  if (disposition?.kind === 'declared') {
    declaredHits++;
    continue;
  }
  if (disposition?.kind === 'idiom') {
    idiomHits++;
    continue;
  }
  undeclared.push({ files, hits, lines: hits[0].lines });
}

undeclared.sort((a, b) => b.lines - a.lines);

for (const group of undeclared) {
  console.error(`FAIL ${group.lines} identical lines in ${group.files.length} files:`);
  for (const hit of group.hits) console.error(`       ${hit.file}  ::  ${hit.name}()`);
  console.error('');
}

if (undeclared.length > 0) {
  console.error(
    `${undeclared.length} undeclared cross-file duplicate function bod(y|ies).\n\n` +
      'Each one is a rule with more than one implementation, and a fix will reach only the copy\n' +
      'its author had open - the defect that shipped a midnight day boundary to the month grid\n' +
      'and the PDF on 2026-09-16 while the list rendered 05:00 correctly.\n\n' +
      'Extract it to one function and call it from both, or - if the copies must stay apart -\n' +
      'add the group to DECLARED_GROUPS or ACKNOWLEDGED_IDIOMS in\n' +
      '.github/scripts/lib/declared-duplicates.mjs, saying WHY.'
  );
  process.exit(1);
}

console.log(
  `OK: no undeclared cross-file duplicate bodies (>= ${MIN_BODY_LINES} lines) in ${ROOTS.join(', ')}.`
);
console.log(`     ${declaredHits} matched a declared group, ${idiomHits} an acknowledged idiom.`);
