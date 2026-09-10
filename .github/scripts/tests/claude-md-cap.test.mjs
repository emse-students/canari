#!/usr/bin/env bun
/**
 * IS `CLAUDE.md` STILL UNDER THE CAP IT SETS FOR ITSELF?
 *
 * The file carries a line cap, and the reason is written into it: it is the INDEX, so a rule
 * needing a paragraph belongs in `durable-rules`, a story in `CHANGELOG.md` and a measurement on
 * the topical wiki page. Its own words are *"A cap the file itself breaks is worse than no cap."*
 *
 * IT BROKE IT BY FOURTEEN LINES AND NOTHING SAID SO (measured 2026-09-10). A number written in
 * prose is a number nobody re-measures - the same absence as a name-based allowlist, arriving from
 * the other direction. The remedy is the one the user asked for standing:
 * *"Je prefere blinder de test et faire les choses automatiquement qu'avoir une review humaine qui
 * n'arrive jamais."*
 *
 * THE CAP IS READ FROM THE FILE, NEVER RESTATED HERE. One place names it, this reads it, and the
 * shape is `.bun-version`'s. Raising it therefore stays possible and stays VISIBLE: it is an edit
 * to the sentence, in the diff, next to the reason. Deleting the sentence does not disable the
 * test - that is its first assertion.
 *
 * Usage: bun .github/scripts/tests/claude-md-cap.test.mjs   (no arguments, no network)
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const INDEX = 'CLAUDE.md';

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass += 1;
  console.log(`  ok    ${m}`);
};
const no = (m) => {
  fail += 1;
  console.log(`  FAIL  ${m}`);
};

const source = readFileSync(resolve(repoRoot, INDEX), 'utf8');

// A file with no trailing newline still has a last line; `split` on the final empty string does not.
const lines = source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;

console.log(`\n${INDEX} states its own cap`);
// =================================================================================================
// The sentence is the single source of the number. If it is gone, the cap is unknowable and this
// test must say so rather than pick a default - a default would be a second copy of the decision.
const declared = source.match(/The cap is ~(\d+) lines/);
if (!declared) {
  no(`${INDEX} no longer says "The cap is ~N lines" - the cap it is measured against is now unstated`);
} else {
  ok(`the cap is declared in ${INDEX} itself, and reads ~${declared[1]} lines`);
}

const cap = declared ? Number(declared[1]) : null;
if (cap !== null && cap >= 100 && cap <= 1000) {
  ok(`the declared cap is a plausible line count (${cap})`);
} else if (cap !== null) {
  no(`the declared cap is ${cap}, which is not a plausible line count - check the sentence parsed`);
}

console.log(`\n${INDEX} is under it`);
// =================================================================================================
// THE MARGIN IS PRINTED EITHER WAY. A file sitting one line under a cap is a file about to break
// it, and a test that only speaks when it fails gives the next session no warning at all.
if (cap === null) {
  no('cannot measure the file against a cap it does not declare');
} else if (lines <= cap) {
  ok(`${INDEX} is ${lines} lines, ${cap - lines} under the cap of ${cap}`);
} else {
  no(
    `${INDEX} is ${lines} lines, ${lines - cap} OVER its own cap of ${cap} - move a rule to ` +
      'docs/wiki/durable-rules.md, a story to CHANGELOG.md, or a measurement to the topical wiki page',
  );
}

console.log(`\n${pass + fail} assertions, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
