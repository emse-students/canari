#!/usr/bin/env bun
/**
 * NO PIPELINE ENDS IN AN EARLY-EXITING READER (`| grep -q`, `| grep -m N`, `| head ...`).
 *
 * `grep -q` exits on its FIRST match and closes the pipe; the writer on the left then dies of
 * SIGPIPE (or fails EPIPE), and under `set -o pipefail` - which every script here and every
 * workflow `run:` block runs under - the pipeline FAILS precisely when the line WAS found. It
 * depends on the left side outgrowing the pipe buffer (64 KiB), so it passes on a small fixture
 * and breaks the day the real input grows: it did, three times (migration-hold.sh, release-chain
 * test, and rolling.sh's `nginx -T` dump, which failed the dev deploy of v1.6.4-alpha.1).
 *
 * `| head -1` is the same defect: `x=$(find ... | head -1)` under `set -e` + pipefail fails with 141
 * once find's output outgrows the pipe buffer. A reader that consumes ALL its input is safe:
 * `sed -n 1p`, `sed -n 1,20p`, `awk 'NR==1'` (NOT `sed 1q`, NOT `awk ...exit`), or `mapfile` then an
 * index.
 *
 * The forms that are safe, in order of preference:
 *   - the input is a variable:   `grep -q PATTERN <<<"$var"`     (no pipe at all)
 *   - the input is a file:       `grep -q PATTERN "$file"`
 *   - the input is a process:    `cmd | grep PATTERN >/dev/null` (reads to the end, so no SIGPIPE)
 *
 * A line is checked after its `\` / trailing-`|` continuations are joined; comment lines are not.
 * `||` is not a pipe. Every pattern is proved against a sample it must flag and a near-miss it must
 * not, so a regex broken into matching nothing fails here before the scan can pass on everything.
 *
 * EXEMPT, with the reason:
 *   - `infrastructure/lib/log-retention.sh`: `docker logs | head -n 1` is DELIBERATE - it reads the
 *     first line of a log that can be gigabytes, and the function takes docker's status from
 *     `PIPESTATUS` and accepts 141 explicitly, so the early exit is handled, not accidental.
 *   - `.github/scripts/tests/rolling-fixture/*`: FROZEN copies of the libraries older releases
 *     shipped, run verbatim to prove a rollback by an old release; editing them would falsify it.
 *   - `.husky/pre-commit`: `#!/bin/sh` with no `pipefail`, so a `| grep -q` there only ever reports
 *     grep's own status.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));

const EXEMPT = [/^infrastructure\/lib\/log-retention\.sh$/, /^\.github\/scripts\/tests\/rolling-fixture\//, /^\.husky\/pre-commit$/];

/**
 * A `|` that is not half of `||`, then a grep whose leading flags include `q` / `m` (any case-
 * sensitive letter run) or the long `--quiet` / `--silent` / `--max-count`.
 */
const EARLY_READER =
  /(?<!\|)\|(?!\|)\s*(?:\S*\/)?(?:(?:e|f)?grep\s+(?:(?:-[A-Za-z]*[qm][A-Za-z0-9]*|--quiet|--silent|--max-count\S*)(?:\s|$)|(?:-[A-Za-z0-9]+\s+)+(?:-[A-Za-z]*[qm][A-Za-z0-9]*|--quiet|--silent|--max-count\S*)(?:\s|$))|head(?:\s|$|\)))/;

/** Joins a `\` or trailing-`|` continuation into one logical line, keeping the first line number. */
function logicalLines(text) {
  const out = [];
  let pending = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trimEnd();
    const joined = pending ? { no: pending.no, text: `${pending.text} ${line.trim()}` } : { no: i + 1, text: line };
    const yamlBlockOpener = /^\s*(?:-\s+)?[\w-]+:\s*[|>][-+]?$/.test(line);
    if (/(\\|(?<!\|)\|)$/.test(line) && !/^\s*#/.test(line) && !yamlBlockOpener) {
      pending = { no: joined.no, text: joined.text.replace(/\\$/, '') };
    } else {
      pending = null;
      out.push(joined);
    }
  });
  if (pending) out.push(pending);
  return out;
}

/** Returns `[lineNumber, text]` of every pipeline in `text` that ends in an early-exiting reader. */
export function offenders(text) {
  return logicalLines(text)
    .filter(({ text: t }) => !/^\s*#/.test(t) && EARLY_READER.test(t))
    .map(({ no, text: t }) => [no, t.trim()]);
}

let failed = 0;
const fail = (msg) => {
  failed += 1;
  console.error(`FAIL ${msg}`);
};

// Self-test.
const MUST_FLAG = [
  `if printf '%s\\n' "$dump" | grep -qxF "# render $TOKEN"; then`,
  `echo "$X" | grep -q foo`,
  `cmd | tee >(cat >&2) | grep -qx 'OK'`,
  `cmd | grep -Eq "^a"`,
  `cmd | grep -m1 foo`,
  `x=$(find . -name a | head -1)`,
  `cmd | head -n 1`,
  `cmd | head -c 40 > out`,
  `cmd | grep -oE 'x' | head -3 | tr a b`,
  `cmd | grep -E --quiet foo`,
  `cmd | grep -E -q foo`,
  `x=$(cmd | /usr/bin/grep -q foo)`,
  'cmd |\n  grep -q foo',
  'cmd \\\n  | grep -q foo',
];
const MUST_PASS = [
  `grep -qxF "# render $TOKEN" <<<"$dump"`,
  `cmd | grep -x 'OK' >/dev/null`,
  `cmd | grep -E 'a|b'`,
  `cmd || grep -q foo "$file"`,
  `# cmd | grep -q foo (a comment explaining the defect)`,
  `x=$(find . -name a | sed -n 1p)`,
  `head -1 "$file"`,
  `cmd | ahead -1`,
  `# x=$(find | head -1) is the defect`,
  `cmd | grep -e 'quiet' -- file`,
  `grep -q foo "$file" || echo no`,
];
for (const s of MUST_FLAG) if (offenders(s).length === 0) fail(`not flagged: ${s}`);
for (const s of MUST_PASS) if (offenders(s).length > 0) fail(`flagged a safe line: ${s}`);

const tracked = execFileSync('git', ['ls-files', '--', '*.sh', '*.yml', '*.yaml', 'Makefile', '.husky/*'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((f) => !EXEMPT.some((re) => re.test(f)));

for (const file of tracked) {
  for (const [no, text] of offenders(readFileSync(join(ROOT, file), 'utf8'))) {
    fail(
      `${file}:${no}: a pipeline ends in an early-exiting reader, which fails under pipefail exactly when it matches (SIGPIPE/EPIPE on the writer) once the input outgrows the pipe buffer: ${text}\n` +
        `  fix: \`grep -q PATTERN <<<"$var"\` for a variable, \`grep -q PATTERN "$file"\` for a file, or \`cmd | grep PATTERN >/dev/null\` for a process stream; for \`| head -N\` use \`| sed -n 1,Np\` (reads all input) or mapfile`
    );
  }
}

if (failed > 0) process.exit(1);
console.log(`pipefail-early-reader: ${tracked.length} tracked shell/yaml files scanned, no early-exiting reader at the end of a pipeline`);
