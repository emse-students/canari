#!/usr/bin/env bun
/**
 * NO PIPELINE ENDS IN AN EARLY-EXITING READER (`| grep -q`, `| grep -m N`, `| head`, `| sed 1q`,
 * `| awk '... exit ...'`).
 *
 * `grep -q` exits on its FIRST match and closes the pipe; the writer on the left then dies of
 * SIGPIPE (or fails EPIPE), and under `set -o pipefail` - which every script here and every
 * workflow `run:` block runs under - the pipeline FAILS precisely when the line WAS found. It
 * depends on the left side outgrowing the pipe buffer (64 KiB), so it passes on a small fixture
 * and breaks the day the real input grows: it did, three times (migration-hold.sh, release-chain
 * test, and rolling.sh's `nginx -T` dump, which failed the dev deploy of v1.6.4-alpha.1).
 *
 * `| head -1` is the same defect: `x=$(find ... | head -1)` under `set -e` + pipefail fails with 141
 * once find's output outgrows the pipe buffer, and so are `sed 1q` and an `awk` that `exit`s. A
 * reader that consumes ALL its input is safe: `sed -n 1p`, `sed -n 1,20p`, `awk 'NR==1'`, or
 * `mapfile` then an index.
 *
 * The forms that are safe, in order of preference:
 *   - the input is a variable:   `grep -q PATTERN <<<"$var"`     (no pipe at all)
 *   - the input is a file:       `grep -q PATTERN "$file"`
 *   - the input is a process:    `cmd | grep PATTERN >/dev/null` (reads to the end, so no SIGPIPE)
 *
 * WHAT IS READ: every tracked `*.sh`, `*.yml`, `*.yaml`, `Makefile` and `.husky/*` file, after its
 * `\` / trailing-`|` continuations are joined. Every command that follows a `|` or `|&` (outside
 * quotes, `||` excluded) is classified: a `grep` / `egrep` / `fgrep` / `rg` with `-q` / `-m` / `--quiet`
 * / `--silent` / `--max-count` in ANY position, `head` in any form, a `sed` script with a `q`
 * command, an `awk` script that `exit`s outside an `END` block. Comments are not read.
 * Every rule is proved against a sample it must flag and a near-miss it must not, so a rule broken
 * into matching nothing fails here before the scan can pass on everything.
 *
 * EXEMPT, with the reason - this list is the whole of it, and docs/wiki/durable-rules.md repeats it:
 *   - `.github/scripts/tests/rolling-fixture/*`: FROZEN copies of the libraries older releases
 *     shipped, run verbatim to prove a rollback by an old release; editing them would falsify it.
 *   - `.husky/pre-commit`: `#!/bin/sh` with no `pipefail`, so a `| grep -q` there only ever reports
 *     grep's own status.
 *   - a single pipeline carrying the marker `pipefail-early-reader: ok - <reason>` in a comment on
 *     one of its lines or on the line above it (today: `log_oldest_line_before` in
 *     `infrastructure/lib/log-retention.sh`, which reads the first line of a log of unbounded size
 *     and takes docker's status from `PIPESTATUS`, accepting 141 explicitly).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));

const EXEMPT_FILES = [/^\.github\/scripts\/tests\/rolling-fixture\//, /^\.husky\/pre-commit$/];
const MARKER = 'pipefail-early-reader: ok';

/** Removes a trailing shell comment (an unquoted `#` at the start of a word) from one line. */
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"') i += 1;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '\\') i += 1;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * Returns the command segments that FOLLOW a pipe in `line`: the text after each unquoted `|` or
 * `|&` up to the next unquoted `|`, `;`, `&&` or `)`. `||` is not a pipe. A `$(...)` is entered
 * even inside double quotes, because `x="$(cmd | head -1)"` is the commonest form of the defect.
 */
export function segmentsAfterPipe(line) {
  const segs = [];
  const stack = ['top'];
  let cur = null;
  const end = () => {
    if (cur !== null) segs.push(cur);
    cur = null;
  };
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    const ctx = stack[stack.length - 1];
    if (cur !== null) cur += c;
    if (ctx === 'sq') {
      if (c === "'") stack.pop();
    } else if (ctx === 'dq') {
      if (c === '"') stack.pop();
      else if (c === '\\') {
        i += 1;
        if (cur !== null) cur += line[i] ?? '';
      } else if (c === '$' && line[i + 1] === '(') {
        stack.push('cmd');
        end();
        i += 1;
      }
    } else if (c === "'") stack.push('sq');
    else if (c === '"') stack.push('dq');
    else if (c === '\\') {
      i += 1;
      if (cur !== null) cur += line[i] ?? '';
    } else if (c === '$' && line[i + 1] === '(') {
      stack.push('cmd');
      end();
      i += 1;
    } else if (c === ')') {
      if (cur !== null) cur = cur.slice(0, -1);
      end();
      if (ctx === 'cmd') stack.pop();
    } else if (c === '|') {
      if (cur !== null) cur = cur.slice(0, -1);
      end();
      if (line[i + 1] === '|') i += 1;
      else {
        cur = '';
        if (line[i + 1] === '&') i += 1;
      }
    } else if (c === ';' || (c === '&' && line[i + 1] === '&')) {
      if (cur !== null) cur = cur.slice(0, -1);
      end();
      if (c === '&') i += 1;
    }
  }
  end();
  return segs;
}

/** Splits a segment into words, keeping quoted runs whole (quotes stay on the token). */
const words = (seg) => seg.match(/(?:[^\s'"]|'[^']*'|"(?:[^"\\]|\\.)*")+/g) ?? [];
const unquote = (w) => w.replace(/^(['"])([\s\S]*)\1$/, '$2');

/** Returns why the command in `seg` exits before reading all its input, or null. */
export function earlyReader(seg) {
  const toks = words(seg);
  if (toks.length === 0) return null;
  const cmd = unquote(toks[0]).split('/').pop();
  const args = toks.slice(1);
  if (cmd === 'head') return 'head';
  if (['grep', 'egrep', 'fgrep', 'rg', 'zgrep'].includes(cmd)) {
    for (const a of args) {
      if (a === '--') break;
      if (/^--(quiet|silent|max-count)(=|$)/.test(a)) return `${cmd} ${a}`;
      if (/^-[A-Za-z0-9]*[qm][A-Za-z0-9]*$/.test(a)) return `${cmd} ${a}`;
    }
    return null;
  }
  if (cmd === 'sed') {
    for (const a of args) {
      if (/^-/.test(a)) continue;
      if (/(?:^|[;{}\s\d$/])q\s*(?:[;}]|$)/.test(unquote(a))) return 'sed q command';
    }
    return null;
  }
  if (['awk', 'gawk', 'mawk'].includes(cmd)) {
    for (const a of args) {
      const s = unquote(a);
      if (/\bexit\b/.test(s) && !/\bEND\b/.test(s)) return 'awk exit';
    }
  }
  return null;
}

/**
 * Returns `[lineNumber, text, why]` of every pipeline in `text` whose reader exits early, minus the
 * ones carrying the marker. Continuations are joined and the first line number is kept.
 */
export function offenders(text) {
  const raws = text.split(/\r?\n/);
  const found = [];
  let start = -1;
  let acc = '';
  const flush = (lastIdx) => {
    const group = raws.slice(start, lastIdx + 1);
    const marked =
      group.some((r) => r.includes(MARKER)) || (start > 0 && raws[start - 1].includes(MARKER));
    for (const seg of segmentsAfterPipe(acc)) {
      const why = earlyReader(seg);
      if (why && !marked) found.push([start + 1, group.map((g) => g.trim()).join(' ').trim(), why]);
    }
  };
  raws.forEach((raw, i) => {
    const code = stripComment(raw.trimEnd());
    if (start < 0) {
      start = i;
      acc = '';
    }
    const yamlBlockOpener = /^\s*(?:-\s+)?[\w-]+:\s*[|>][-+]?$/.test(code);
    const continues = /(\\|(?<!\|)\|)\s*$/.test(code) && !yamlBlockOpener;
    acc += ` ${code.replace(/\\$/, '')}`;
    if (!continues) {
      flush(i);
      start = -1;
    }
  });
  if (start >= 0) flush(raws.length - 1);
  return found;
}

let failed = 0;
const fail = (msg) => {
  failed += 1;
  console.error(`FAIL ${msg}`);
};

// Self-test: every sample the guard must flag, and every near-miss it must not.
const MUST_FLAG = [
  `if printf '%s\\n' "$dump" | grep -qxF "# render $TOKEN"; then`,
  `echo "$X" | grep -q foo`,
  `cmd | tee >(cat >&2) | grep -qx 'OK'`,
  `cmd | grep -Eq "^a"`,
  `cmd | grep -m1 foo`,
  `cmd | grep -E --quiet foo`,
  `cmd | grep -E --silent foo`,
  `cmd | grep -E -q foo`,
  `cmd | grep PAT -q`,
  `cmd | grep -e PAT -q`,
  `cmd | grep -e 'a|b' -E -q`,
  `cmd |& grep -q foo`,
  `x=$(cmd | /usr/bin/grep -q foo)`,
  `cmd | rg -q foo`,
  `cmd | rg --max-count 1 foo`,
  'cmd |\n  grep -q foo',
  'cmd \\\n  | grep -q foo',
  `x=$(find . -name a | head -1)`,
  `x="$(find . -name a | head -1)"`,
  `x="$(cmd | grep -q a)"`,
  `echo "$(cmd | awk '{ print; exit }')"`,
  `cmd | head -n 1`,
  `cmd | head -c 40 > out`,
  `cmd | grep -oE 'x' | head -3 | tr a b`,
  `x=$(cmd | head)`,
  `cmd | head; echo done`,
  `cmd | sed 1q`,
  `cmd | sed -n '1{p;q}'`,
  `cmd | sed -n '1p;q'`,
  `cmd | sed '/x/q'`,
  `cmd | awk 'NR==1{print;exit}'`,
  `ip route | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }'`,
  `cmd | awk -F'\\t' '$1 == k { print $c; exit }'`,
];
const MUST_PASS = [
  `grep -qxF "# render $TOKEN" <<<"$dump"`,
  `cmd | grep -x 'OK' >/dev/null`,
  `cmd | grep -E 'a|b'`,
  `cmd || grep -q foo "$file"`,
  `# cmd | grep -q foo (a comment explaining the defect)`,
  `cmd | grep -e 'quiet' -- file`,
  `cmd | grep -e PAT -- -q`,
  `grep -q foo "$file" || echo no`,
  `x=$(find . -name a | sed -n 1p)`,
  `cmd | sed -n 1,20p`,
  `cmd | sed 's/q//'`,
  `cmd | sed -n 's/^q//p'`,
  `cmd | sed 's/a/q/'`,
  `cmd | awk 'NR==1'`,
  `cmd | awk '{ n++ } END { print n; exit }'`,
  `head -1 "$file"`,
  `cmd | ahead -1`,
  `# x=$(find | head -1) is the defect`,
  `cmd | grep -x 'a' # x | head -1`,
  `echo "a | head -1" | cat`,
  `cmd | grep -o 'x' | cut -d, -f1`,
  `cmd | wc -l`,
];
for (const s of MUST_FLAG) if (offenders(s).length === 0) fail(`not flagged: ${s}`);
for (const s of MUST_PASS) if (offenders(s).length > 0) fail(`flagged a safe line: ${s}`);
const marked = [
  `x=$(cmd | head -1) # pipefail-early-reader: ok - handled`,
  '# pipefail-early-reader: ok - handled\nx=$(cmd | head -1)',
  'x=$(cmd | head -n 1 # pipefail-early-reader: ok - handled\n  exit "${PIPESTATUS[0]}")',
];
for (const s of marked) if (offenders(s).length > 0) fail(`the marker was not honoured: ${s}`);
if (offenders('# pipefail-early-reader: ok - x\n\nx=$(cmd | head -1)').length === 0) {
  fail('the marker reached two lines below its comment');
}

const tracked = execFileSync(
  'git',
  ['ls-files', '--', '*.sh', '*.yml', '*.yaml', 'Makefile', '.husky/*'],
  { cwd: ROOT, encoding: 'utf8' }
)
  .split('\n')
  .filter(Boolean)
  .filter((f) => !EXEMPT_FILES.some((re) => re.test(f)));

for (const file of tracked) {
  for (const [no, text, why] of offenders(readFileSync(join(ROOT, file), 'utf8'))) {
    fail(
      `${file}:${no}: a pipeline ends in an early-exiting reader (${why}), which fails under pipefail exactly when it exits early (SIGPIPE/EPIPE on the writer) once the input outgrows the pipe buffer: ${text}\n` +
        `  fix: \`grep -q PATTERN <<<"$var"\` for a variable, \`grep -q PATTERN "$file"\` for a file, \`cmd | grep PATTERN >/dev/null\` for a process stream; for \`| head -N\` / \`sed 1q\` / \`awk ...exit\` use \`| sed -n 1,Np\` / \`awk 'NR==1'\` (they read all input) or mapfile; a reader that is handled on purpose carries a \`# ${MARKER} - <reason>\` comment`
    );
  }
}

if (failed > 0) process.exit(1);
console.log(
  `pipefail-early-reader: ${tracked.length} tracked shell/yaml files scanned, no early-exiting reader at the end of a pipeline`
);
