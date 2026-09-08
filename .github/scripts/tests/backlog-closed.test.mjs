#!/usr/bin/env node
/**
 * NO ENTRY IN THE BACKLOG MAY READ AS CLOSED - the file's own first rule, asserted at last.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION. `docs/wiki/backlog.md` has said **NOTHING FIXED BELONGS
 * IN THIS FILE** in bold since 2026-08-30, on the user's instruction, and it says twice more that an
 * entry is deleted outright when it ships - the rule goes to `durable-rules`, the story to
 * `CHANGELOG.md`, the mechanism to the wiki page the entry points at. On 2026-09-08 the file
 * nevertheless held **fourteen** closed entries and 462 lines of them, some ten days old.
 *
 * That is the campaign's own lesson turned on the repository's memory: a correct rule with nothing
 * to report it is followed until somebody is busy, and then it is not. The rule was never the
 * problem and restating it more firmly would not have helped - what was missing is the thing that
 * notices. The cost is real and compounding: a closed entry is indistinguishable, at a glance, from
 * an open one, so every reader pays for it, the severity counts that decide what to work on are
 * wrong, and the queue stops being readable exactly as the header predicted.
 *
 * **WHAT COUNTS AS CLOSED, AND WHY THE LIST IS SHORT.** A heading struck through, or one whose text
 * announces its own completion. The needles are the words this repository actually uses -
 * `RETIRED`, `CLOSED`, `FIXED`, `DONE`, `ANSWERED` - and nothing cleverer, because a checker that
 * guesses is one whose next false positive gets it deleted rather than obeyed.
 *
 * **AN ENTRY WITH A CLOSED HALF IS NOT A CLOSED ENTRY**, and this is the distinction that keeps the
 * rule honest rather than merely tidy. Three entries were kept on 2026-09-08 because a real half
 * remained - three hosts nobody reports on, a repair that still costs three minutes, a fix that is
 * merged and NOT SHIPPED. Each was retitled to name what is LEFT instead of what is done, which is
 * what the header means by "the shipped half is a pointer, never a retelling". So this test does not
 * forbid the words in a BODY: it forbids a heading that announces closure, because the heading is
 * what a reader scanning the file actually sees.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const FILE = join(ROOT, 'docs', 'wiki', 'backlog.md');

/** The words this repository uses to retire something. Whole words, so `UNANSWERED` is not `ANSWERED`. */
const CLOSED_WORDS = /\b(RETIRED|CLOSED|FIXED|DONE|ANSWERED)\b/;

/**
 * Whether a heading announces its own completion.
 *
 * Struck-through titles are the unambiguous case. The word test is deliberately applied to the
 * heading ONLY: a body may and should say a half is fixed, and forbidding that would push the
 * reasoning out of the file rather than the closed work.
 */
function readsAsClosed(heading) {
  const text = heading.replace(/^#+\s*/, '');
  return text.startsWith('~~') || CLOSED_WORDS.test(text);
}

const lines = readFileSync(FILE, 'utf8').split('\n');
const offenders = [];
let inFence = false;
for (const [i, line] of lines.entries()) {
  // A fenced block can hold anything, including a log line with the word FIXED in it.
  if (/^\s*```/.test(line)) inFence = !inFence;
  if (inFence || !line.startsWith('###')) continue;
  if (readsAsClosed(line)) offenders.push(`  backlog.md:${i + 1}  ${line.replace(/^#+\s*/, '').slice(0, 120)}`);
}

if (offenders.length > 0) {
  console.error(`FAIL: ${offenders.length} backlog entr(ies) read as closed and must not be in this file:\n`);
  for (const o of offenders) console.error(o);
  console.error(
    '\nDelete the entry outright: the rule goes to docs/wiki/durable-rules.md, the story to' +
      '\nCHANGELOG.md, the mechanism to the wiki page the entry points at. If a real half is still' +
      '\nopen, do NOT keep the closed title - retitle the entry to name what is LEFT.'
  );
  process.exit(1);
}

console.log(`OK: ${lines.length} lines of backlog, no entry reads as closed.`);
