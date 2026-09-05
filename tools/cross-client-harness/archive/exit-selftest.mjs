/**
 * A CHECK MAY NOT REPORT SUCCESS AND END IN THE SAME BREATH.
 *
 * `results.mjs` derives the exit code from the verdicts a script recorded, through a `beforeExit`
 * hook that needs nothing added to any script - and that fires only when the event loop IDLES. A
 * check holding CDP sockets or an adb forward never idles, so its process sits there after its last
 * line has printed: measured 2026-09-05 on `tab236.mjs` (alive twenty-five minutes past `1/1 pass`)
 * and on `tab4.mjs` (three rows written, the runner still blocked six minutes later).
 *
 * THE OBVIOUS REPAIR IS THE DEFECT. A bare `process.exit(0)` ends the process and claims a pass at
 * once, so a recorded FAIL is reported as `done`. Six files in this tree carry a comment saying so,
 * each written the day that file was caught; `tab236.mjs` then acquired a fresh one on 2026-09-05,
 * under a comment stating the code was derived. A rule six comments already know is a rule nothing
 * enforces, which is why this file exists.
 *
 * The predicate is deliberately narrow: a literal `process.exit(0)`, in code rather than in a
 * comment, on a line AFTER the first `record(` in the same file. An early opt-out that runs before
 * any verdict exists - `del1.mjs --keep`, `newdevice.mjs --dry` - is not this defect and is not
 * flagged. `exitOnRecorded()` is the ending that is both.
 *
 *   bun archive/exit-selftest.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));

let failures = 0;
const ok = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}   ${label}`);
  if (!cond) failures++;
};

/** Everything a `//` comment or a jsdoc continuation line contributes is not code. */
const strip = (line) => line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');

/** @returns {string[]} `line:number` for every exit-0 that stands downstream of a recorded verdict. */
export function unconditionalExitsAfterRecording(source) {
  const lines = source.split('\n').map(strip);
  const firstRecord = lines.findIndex((l) => /\b(?:record|recordObserved)\(/.test(l));
  if (firstRecord === -1) return [];
  const found = [];
  lines.forEach((l, i) => {
    if (i > firstRecord && /process\.exit\(0\)/.test(l)) found.push(String(i + 1));
  });
  return found;
}

/**
 * THE OTHER HALF: a check that records, holds a CDP socket and never says how it ends.
 *
 * `beforeExit` fires only when the loop idles, and an open CDP socket means it never does. Such a
 * script runs off its end, keeps its process alive with the verdict already written, and blocks
 * every row queued behind it - `tab5.mjs` and `notif.mjs` were both in this state on 2026-09-05,
 * and `tab4.mjs` cost six minutes a run. Nothing about it looks like a failure, which is why it is
 * asserted rather than noticed.
 *
 * Both sides are read from real import statements, not from a word appearing anywhere in the file:
 * `atoms.mjs` describes `record(...)` in a doc comment and records nothing, and a rule that cannot
 * tell prose from code will be switched off by whoever meets that first.
 *
 * @returns {boolean} true when the file owes an ending it does not have
 */
export function endsWithoutSayingSo(source) {
  const imports = source.match(/import {[^}]*} from '[^']*(?:results|cdp|chat).mjs';/g) ?? [];
  const records = imports.some((i) => i.includes('results.mjs') && i.includes('record'));
  const opensCdp = imports.some(
    (i) => (i.includes('cdp.mjs') || i.includes('chat.mjs')) && (i.includes('client') || i.includes('connect')),
  );
  if (!records || !opensCdp) return false;
  // FIVE ENDINGS, AND CLOSING THE SOCKET IS ONE OF THEM. The first version of this rule accepted
  // only the exits and flagged thirty checks that end `w1.close(); w2.close();` - which lets the
  // loop idle, which is precisely what makes `beforeExit` fire. A gate that condemns the correct
  // majority gets deleted, not obeyed. What is left after this is the real shape: a script that
  // opens sockets, records a verdict, closes nothing and exits nowhere.
  //
  // `process.exit(` is honest here because rule one above already bans the one exit that lies.
  return !(
    source.includes('exitOnRecorded(') ||
    source.includes('finish(') ||
    source.includes('finishObserved(') ||
    source.includes('process.exit(') ||
    source.includes('.close()')
  );
}

// ── the predicate itself, before it is trusted on 170 files ─────────────────────────────────────
const RECORDING = "record('X-1', v, {});\n";
ok('an exit-0 under a record is flagged', unconditionalExitsAfterRecording(RECORDING + 'process.exit(0);').length === 1);
ok('and it is flagged at the right line', unconditionalExitsAfterRecording(RECORDING + 'process.exit(0);')[0] === '2');
ok(
  'an exit-0 BEFORE any record is an opt-out, not this defect',
  !unconditionalExitsAfterRecording('if (dry) process.exit(0);\n' + RECORDING).length,
);
ok(
  'a file that records nothing is not in scope at all',
  !unconditionalExitsAfterRecording('console.log(1);\nprocess.exit(0);').length,
);
ok(
  'the same text in a // comment is not code',
  !unconditionalExitsAfterRecording(RECORDING + '// process.exit(0) used to sit here\n').length,
);
ok(
  'nor in a jsdoc continuation',
  !unconditionalExitsAfterRecording(RECORDING + ' * `process.exit(0)` reported success\n').length,
);
ok(
  'a derived exit is exactly what the rule asks for',
  !unconditionalExitsAfterRecording(RECORDING + "process.exit(row.verdict === 'PASS' ? 0 : 1);").length,
);
ok(
  'and so is exitOnRecorded()',
  !unconditionalExitsAfterRecording(RECORDING + 'exitOnRecorded();').length,
);

// ASSEMBLED, NOT WRITTEN OUT. `instrument.mjs` computes a runner's module set by reading import
// specifiers out of the file text, and `gate-selftest.mjs` then refuses a self-test whose set
// reaches outside git. A fixture that LOOKS like an import is read as one, so these two would drag
// `results.mjs` -> `names.mjs` -> the out-of-tree state directory into this file's set and the
// gate would - correctly, on what it can see - call this self-test unrunnable on a fresh checkout.
const FROM = "from '";
const CDP = `import { client } ${FROM}../cdp.mjs';\n`;
const REC = `import { mark, record } ${FROM}../results.mjs';\n`;
ok('a recording CDP check with no ending is flagged', endsWithoutSayingSo(CDP + REC + 'record(1);\n'));
ok('one that calls exitOnRecorded is not', !endsWithoutSayingSo(CDP + REC + 'exitOnRecorded();\n'));
ok(
  'nor one that exits on its own row',
  !endsWithoutSayingSo(CDP + REC + "process.exit(row.verdict === 'PASS' ? 0 : 1);\n"),
);
ok(
  'nor one that closes its sockets - an idle loop is exactly what beforeExit waits for',
  !endsWithoutSayingSo(CDP + REC + 'w1.close();\n'),
);
ok('nor one that finishes', !endsWithoutSayingSo(CDP + REC + "finishObserved('X', v, {}, o);\n"));
ok(
  'a check that opens no CDP socket owes nothing - beforeExit reaches it',
  !endsWithoutSayingSo(REC + 'record(1);\n'),
);
ok(
  'and prose about record() is not an import',
  !endsWithoutSayingSo(CDP + ' * a second atom growing a record(...) shows up\n'),
);

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

// A WALK THAT MATCHED NOTHING PASSES EVERY RULE. The count is asserted so a broken walk fails here
// rather than reporting a clean tree it never opened - the same guard `spawn-selftest.mjs` carries.
ok(`the walk reached the harness (${files.length} files)`, files.length > 100);

const offenders = [];
for (const f of files) {
  // The two files the rule is MADE of: `results.mjs`, where the derivation lives, and this one,
  // whose fixtures above are the offending shape written on purpose. Excluding them is not a hole -
  // a gate that cannot state its own counter-example has no counter-example.
  if (f.endsWith('results.mjs') || f === SELF) continue;
  for (const line of unconditionalExitsAfterRecording(readFileSync(f, 'utf8')))
    offenders.push(`${f.slice(ROOT.length + 1)}:${line}`);
}
ok('no check exits 0 over a verdict it recorded', !offenders.length);

const unending = files.filter((f) => f !== SELF && endsWithoutSayingSo(readFileSync(f, 'utf8')));
ok(
  'no recording check holds a CDP socket without saying how it ends',
  !unending.length,
);
for (const u of unending) console.log(`         ${u.slice(ROOT.length + 1)}`);
for (const o of offenders) console.log(`         ${o}`);

console.log(
  failures
    ? `[exit] ${failures} FAILURE(S) - a check can report 'done' beside a recorded FAIL`
    : '[exit] clean - every ending is derived from the verdicts, and an opt-out before one is left alone',
);
process.exit(failures ? 1 : 0);
