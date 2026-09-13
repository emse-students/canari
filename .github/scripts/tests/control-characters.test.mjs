#!/usr/bin/env bun
/**
 * DOES ANY TRACKED FILE CARRY A CONTROL CHARACTER? BECAUSE NO REVIEW WILL EVER SEE ONE.
 *
 * A text edit that turns `\b` into a literal BACKSPACE (0x08) produces a file that looks right in
 * the diff, in review, in `grep` and in every editor - `JSON.stringify` even prints the byte back as
 * `\b`. A regex holding one matches NOTHING, and says nothing about it. This has now happened four
 * times in this repository:
 *
 * | where | what it cost |
 * | --- | --- |
 * | `watch.mjs`, 2026-09-08 | a classifier rule that could never match; a whole window stayed `NOT CLEAN` and only said the lines were unexplained |
 * | `androidFcmManifest.test.ts` | `/<uses-permission\b[^>]*\/>/` matched 0 tags of 2, so the assertion below it was false because the array was EMPTY - the exact false green its own comment says it exists to prevent |
 * | `paraglideMessages.test.ts` | one alternative of three dead; `partenaire` and `partnership` still matched, so the guard looked healthy while never catching the bare word |
 * | `AssociationTile.test.ts`, 2026-09-13 | caught in the author's own sweep, minutes before it shipped |
 *
 * **THE GUARD WRITTEN AFTER THE FIRST ONE NAMED TWO FILES.** `srvclassify-selftest.mjs` asserted it
 * for `srvlog.mjs` and `watch.mjs` - the two that had been burnt - so the three that followed were
 * outside it, two of them in a test suite of 3900 tests that ran green throughout. That is the
 * repository's own standing rule arriving from the other direction: a list of subjects is a list
 * somebody will add to without telling the gate. This one enumerates nothing. It reads what git
 * tracks.
 *
 * AND THE FIRST VERSION OF THE ORIGINAL GUARD DID NOT WORK EITHER, which is the more useful half and
 * is why this reads BYTES. It tested `regex.source`, and `source` is specified to return text that
 * PARSES BACK to the same regex - so a raw 0x08 comes out of it as the four-character escape `\u0008` and no control
 * character is ever there to find. A guard that cannot see the thing it was written for is worse than
 * none: it turns an open question into a settled one.
 *
 * THERE IS NO ALLOWLIST, DELIBERATELY. Every legitimate use met while writing this - the `\x01`
 * separators in a canonicalisation key, an ANSI escape in an assertion about ANSI escapes - is a
 * character that has a spelled ESCAPE producing the identical value, so writing it visibly costs
 * nothing and an exemption would cost the guard its absoluteness. Tab, newline and carriage return
 * are the three that belong in a text file; everything else below 0x20 is an accident.
 *
 * Usage: bun .github/scripts/tests/control-characters.test.mjs   (no arguments, no network)
 */
import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

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

// NO REGEX HERE ON PURPOSE, and the reason is the subject of the file: a character class spelling
// out C0 is exactly what `no-control-regex` forbids, and silencing that rule to write this one would
// be the wrong trade - the lint is right that a control character in a pattern is almost always an
// accident.
const controlCharsIn = (text) =>
  [...text].filter((c) => {
    const n = c.charCodeAt(0);
    return n < 0x20 && n !== 9 && n !== 10 && n !== 13;
  });

/**
 * Every file git would keep - tracked, plus new files not covered by `.gitignore`.
 *
 * `--others --exclude-standard` is not decoration. Without it this reads only what is TRACKED, so a
 * file being written for the FIRST time is invisible until it is staged - one commit too late, and
 * precisely when a fresh mistake is newest. That was not reasoned out: the first version of this
 * guard ran clean over a backspace in its OWN source, minutes after being written to catch exactly
 * that, because the file was not yet added.
 */
const tracked = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: repoRoot, encoding: 'utf8' },
)
  .split('\0')
  .filter(Boolean);

console.log('\nno tracked file carries a control character');

let scanned = 0;
let skippedBinary = 0;
const offenders = [];

for (const rel of tracked) {
  const full = resolve(repoRoot, rel);
  // A path can be tracked and absent from the working tree (a sparse checkout, a submodule).
  let size;
  try {
    const st = statSync(full);
    if (!st.isFile()) continue;
    size = st.size;
  } catch {
    continue;
  }
  // Binaries are not the subject and decoding them proves nothing: an image full of 0x08 is an
  // image. A file that does not decode as UTF-8 is skipped, and the count is PRINTED rather than
  // swallowed, so a skip that grows is visible instead of being mistaken for a clean pass.
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(full));
  } catch {
    skippedBinary += 1;
    continue;
  }
  if (size === 0) continue;
  scanned += 1;

  text.split('\n').forEach((line, i) => {
    const bad = controlCharsIn(line);
    if (bad.length === 0) return;
    offenders.push({
      rel,
      line: i + 1,
      codes: bad.map((c) => `0x${c.charCodeAt(0).toString(16)}`).join(' '),
      // Printed with the control characters made VISIBLE, because printing them raw would reproduce
      // the original problem in the failure message itself.
      text: JSON.stringify(line.trim().slice(0, 140)),
    });
  });
}

if (offenders.length === 0) {
  ok(`${scanned} tracked text file(s) scanned, ${skippedBinary} binary skipped, none carries one`);
} else {
  no(
    `${offenders.length} line(s) carry a control character - a regex holding one matches NOTHING ` +
      'and reports nothing. Spell the escape (`\\b`, `\\x01`) instead of embedding the byte:',
  );
  for (const o of offenders) console.log(`          ${o.rel}:${o.line} [${o.codes}] ${o.text}`);
}

// THE GUARD MUST BE ABLE TO SEE THE THING IT WAS WRITTEN FOR, which is exactly what the first
// version of the original could not do. Asserted here rather than trusted: a predicate that has
// never been shown a positive is a predicate nobody has tested.
console.log('\nthe predicate can see a control character at all');
const SPECIMEN = `const RULE = /\\[DEVICE_MEMBERSHIPS\\]${String.fromCharCode(8)}/;`;
if (controlCharsIn(SPECIMEN).length === 1) {
  ok('a backspace embedded in a line is found');
} else {
  no('the predicate did not find a backspace it was handed - it can prove nothing');
}
if (controlCharsIn('a\tb\nc\rd').length === 0) {
  ok('tab, newline and carriage return are not findings');
} else {
  no('the predicate flags whitespace, which would make every file an offender');
}

console.log(`\n${pass + fail} assertions, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
