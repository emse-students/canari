/**
 * ONE VOCABULARY, READ BY THE RECORDER AND BY THE RECONCILER, OR BY NEITHER.
 *
 * `results.mjs` is where a verdict comes into existence; `rows.mjs` reads those words back off the
 * board. Each used to carry its own idea of the list, so a runner inventing a word made the
 * reconciler report `board: unstated` for a row the board stated in full - a false accusation in the
 * one report whose whole job is to be right about the board. It happened twice: `INCONCLUSIVE`
 * (PIN-11) and then `SETUP-FAILED` (HEAL-W2, 2026-09-06), the second time directly under a comment
 * predicting it.
 *
 * `verdicts.mjs` now owns the list and both sides import it, which removes the drift. THIS FILE IS
 * THE HALF THAT KEEPS IT REMOVED, because the structure can be undone by one hand-written map:
 *
 *   1. neither side may reintroduce a private list - asserted against the two files' source;
 *   2. every verdict a runner SPELLS OUT anywhere in the rig is in the list - a static scan, and
 *      the one assertion that would have caught both incidents on the day they were written;
 *   3. the board's older spellings all land on a real verdict, so the alias map cannot become the
 *      second vocabulary again;
 *   4. `record()` still refuses a word in neither, at the throw.
 *
 * RULE 4 IS ASSERTED ON SOURCE, NOT BY CALLING IT, and the reason is the gate rather than laziness:
 * `results.mjs` imports `names.mjs`, which is gitignored because it holds real display names and
 * this repository is PUBLIC, so a self-test that imported the recorder would die on a fresh
 * checkout - which `gate-selftest.mjs` refuses on exactly those grounds. The refusal itself is
 * exercised every time any runner records anything.
 *
 * WHAT IT CANNOT SEE: a verdict built from an expression. Sixteen runners compose their row ids that
 * way and a few compose the word too, so rule 2 is a floor rather than a proof - the throw is what
 * covers the rest, at the cost of finding it one run later.
 *
 *   bun archive/verdict-selftest.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_ALIASES, CLAIM, NOT_A_CLAIM, RECORDER_ONLY, VERDICTS, isVerdict } from '../verdicts.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

// ── the list itself ─────────────────────────────────────────────────────────────────────────────
ok(`the vocabulary is not empty (${VERDICTS.length} verdicts)`, VERDICTS.length > 5);
ok('and it is frozen, so no importer can widen it in passing', Object.isFrozen(VERDICTS));
ok('no verdict is listed twice', new Set(VERDICTS).size === VERDICTS.length);
ok('PASS is a verdict - it is the only one that exits 0', isVerdict('PASS'));
ok('an invented word is not', !isVerdict('MOSTLY-FINE'));

// THE TWO INCIDENTS, PINNED BY NAME. They are the reason this file exists, and a list that stopped
// carrying either would have reopened exactly the defect that was fixed.
ok('INCONCLUSIVE is a verdict - PIN-11 read `unstated` when it was not', isVerdict('INCONCLUSIVE'));
ok('SETUP-FAILED is a verdict - HEAL-W2 read `unstated` when it was not', isVerdict('SETUP-FAILED'));

ok(
  'every recorder-only verdict is a verdict',
  RECORDER_ONLY.every((v) => isVerdict(v))
);
ok('UNOBSERVED is recorder-only - a check cannot state that nothing observed it', RECORDER_ONLY.includes('UNOBSERVED'));

// ── the board's half ────────────────────────────────────────────────────────────────────────────
ok(
  'every legacy board spelling names a real verdict',
  Object.values(BOARD_ALIASES).every((v) => isVerdict(v))
);
ok(
  'the claim map recognises every verdict the recorder can write',
  VERDICTS.every((v) => CLAIM[v] === v)
);
ok(
  'and every legacy spelling, mapped onto its verdict',
  Object.entries(BOARD_ALIASES).every(([word, v]) => CLAIM[word] === v)
);
ok(`\`${NOT_A_CLAIM}\` maps to itself and is not a verdict`, CLAIM[NOT_A_CLAIM] === NOT_A_CLAIM && !isVerdict(NOT_A_CLAIM));

// ── neither side may keep a private list ────────────────────────────────────────────────────────
//
// The structural assertion. Both files read the vocabulary through an import; a hand-written map of
// verdict words in either of them is the defect coming back, and it comes back as an EDIT to one
// file rather than as a missing entry, which is precisely the shape nothing was watching.
const importsVocabulary = (file) =>
  /import {[^}]*} from '\.\/verdicts\.mjs';/.test(readFileSync(join(ROOT, file), 'utf8'));
ok('the recorder reads the vocabulary rather than holding one', importsVocabulary('results.mjs'));
ok('and so does the reconciler', importsVocabulary('rows.mjs'));

// AND THE RECORDER STILL REFUSES. Source, not a call: see the note at the top on `names.mjs`.
const recorder = readFileSync(join(ROOT, 'results.mjs'), 'utf8');
ok('the recorder throws on a word the vocabulary does not carry', /if \(!isVerdict\(verdict\)\)\s*\n?\s*throw/.test(recorder));
ok(
  'and on a verdict only it may write',
  /if \(RECORDER_ONLY\.includes\(verdict\)\)\s*\n?\s*throw/.test(recorder)
);

// ── every verdict spelled out in the rig is in the list ─────────────────────────────────────────
/** Everything a `//` comment or a jsdoc continuation line contributes is not code. */
const strip = (line) => line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');

/**
 * Verdict LITERALS at a recording call site, with their line numbers.
 *
 * The four recorders all funnel into `record()`, and the verdict is its second argument: a bare
 * string, or either arm of a ternary - `ok ? 'PASS' : 'FAIL'` is how eighteen MUT rows decide. Both
 * shapes are read; anything composed from a variable is invisible here and is rule 4's business.
 *
 * @returns {string[]} `line:WORD` for every literal that is not a verdict
 */
export function unknownVerdictLiterals(source) {
  const found = [];
  source.split('\n').forEach((raw, i) => {
    const line = strip(raw);
    const call = /\b(?:record|finish|recordObserved|finishObserved)\(\s*(?:'[^']*'|`[^`]*`)\s*,([^;]*)/.exec(line);
    if (!call) return;
    for (const m of call[1].matchAll(/'([A-Z][A-Z-]+)'/g)) {
      if (!isVerdict(m[1])) found.push(`${i + 1}:${m[1]}`);
    }
  });
  return found;
}

// ── the predicate itself, before it is trusted on the tree ──────────────────────────────────────
ok("a known verdict passes", !unknownVerdictLiterals("record('X-1', 'PASS', {});").length);
ok(
  'an invented one is flagged, with its line',
  unknownVerdictLiterals("record('X-1', 'ALMOST', {});")[0] === '1:ALMOST'
);
ok(
  'both arms of a ternary are read',
  unknownVerdictLiterals("finish('X-1', ok ? 'PASS' : 'NEARLY', {});")[0] === '1:NEARLY'
);
ok(
  'a verdict composed from a variable is invisible here, and says so',
  !unknownVerdictLiterals("record('X-1', verdict, {});").length
);
ok('prose in a // comment is not code', !unknownVerdictLiterals("// record('X-1', 'ALMOST')").length);
ok('nor a jsdoc continuation', !unknownVerdictLiterals(" * record('X-1', 'ALMOST', {})").length);

// ── the tree ────────────────────────────────────────────────────────────────────────────────────
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const f = join(d, e);
    if (statSync(f).isDirectory()) {
      if (e !== 'node_modules') walk(f);
    } else if (e.endsWith('.mjs')) files.push(f);
  }
};
walk(ROOT);

// A WALK THAT MATCHED NOTHING PASSES EVERY RULE - the same guard `exit-selftest.mjs` carries.
ok(`the walk reached the harness (${files.length} files)`, files.length > 100);

const offenders = [];
for (const f of files) {
  // This file is the one place the offending shape is written on purpose: a gate that cannot state
  // its own counter-example has no counter-example.
  if (f === SELF) continue;
  for (const hit of unknownVerdictLiterals(readFileSync(f, 'utf8')))
    offenders.push(`${f.slice(ROOT.length + 1)}:${hit}`);
}
ok('every verdict a runner spells out is one the reconciler can read', !offenders.length);
for (const o of offenders) console.log(`         ${o}`);

console.log(
  failures
    ? `[verdict] ${failures} FAILURE(S) - a word one side can write and the other cannot read`
    : '[verdict] clean - one vocabulary, imported by the recorder and by the reconciler'
);
process.exit(failures ? 1 : 0);
