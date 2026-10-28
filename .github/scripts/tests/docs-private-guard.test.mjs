#!/usr/bin/env node
/**
 * THE REPOSITORY IS PUBLIC, SO A TRACKED TEXT MUST NOT CARRY A PRIVATE ADDRESS, AN SSH ALIAS, A
 * WORKSTATION PATH OR A NAMED PIECE OF SOMEBODY ELSE'S INFRASTRUCTURE (decided 2026-10-17, widened
 * 2026-10-28: what helps an attacker lives in the private notes, outside the repo).
 *
 * It reads every tracked `*.md`, every `.env.example`, every `*.sh`, every `*.yml` / `*.yaml`
 * (workflow inputs and their comments are public text too), and the COMMENTS of every tracked
 * `*.ts` / `*.mjs`. ACCEPTED LIMIT: code strings in `*.ts` / `*.mjs`, and other languages (`*.py`,
 * `*.rs`, ...), are not read - a test may legitimately feed a private address to an SSRF guard, so
 * a workstation path or an address in a code string is caught by review, not here. It fails on a private-range address (10/8, 172.16/12, 192.168/16), a
 * school-range public address (193.49.x.x), an `ssh <alias>` naming one of the project's boxes or a
 * `*-target` alias, a path on one workstation's disk, or a numbered hypervisor guest.
 *
 * Every pattern is proved first against a sample it must flag AND a near-miss it must not, and each
 * flagged sample must be flagged BY THAT PATTERN ALONE - so dropping a pattern, or a regex silently
 * broken into matching nothing, fails here before the scan can pass on everything.
 *
 * NAMES ARE NOT IN THIS FILE. Product names and host names of the school's own infrastructure are
 * exactly what this guard keeps out of the repository, so they cannot be committed as its denylist.
 * They are read, one per line (`#` comments allowed), from the file named by
 * `DOCS_PRIVATE_DENYLIST_FILE`, which lives outside the repository. Without it that half of the scan
 * is SKIPPED and says so on stderr; nothing else is skipped. THE DENYLIST HALF IS LOCAL-ONLY AND NOT
 * ENFORCED IN CI, by the owner's decision (2026-10-28): CI holds no copy of the list, so it runs the
 * pattern half alone, and the names half runs on a workstation that has the file.
 *
 * `PENDING_CLEANUP` lists the files another documentation pass has not cleaned yet. It is a
 * work list and NOT a licence: a file leaves it in the pull request that cleans it, and a new file
 * never joins it. An entry whose file no longer exists fails, so the list cannot rot.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const SELF = '.github/scripts/tests/docs-private-guard.test.mjs';

/** `[label, regex]` - what the scan refuses. */
export const PATTERNS = [
  ['private address', /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ['private address', /\b(?:172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/],
  ['school public address', /\b193\.49\.\d{1,3}(?:\.\d{1,3})?\b/],
  ['ssh alias', /\bssh\s+(?:canari|mitv|cercle|miconnect|portail-etu-direct)\b/],
  ['ssh alias', /\bportail-etu-direct\b/],
  ['ssh alias', /\bssh\s+[a-z][a-z-]*-target\b/],
  ['workstation path', /\b[A-Za-z]:[\\/](?:Programmation|Users)\b/],
  ['hypervisor guest id', /\bProxmox\s+(?:CT|VM)\s*\d+\b/],
];

/**
 * `[a line that must be flagged, a near-miss that must not]`, kept APART from the patterns on
 * purpose: deleting a pattern, or breaking its regex, leaves its line unflagged and fails the
 * self-test - and a pattern no line depends on fails it too, so a new pattern brings its case.
 */
const COUNTER_CASES = [
  ['host 10.0.0.4', 'version 1.10.0.4x'],
  ['gateway 172.20.0.1', 'public 172.32.0.1'],
  ['lan 192.168.1.10', 'public 192.169.1.10'],
  ['at 193.49.12.7', 'at 193.4.12.7'],
  ['run ssh canari now', 'the canari host'],
  ['via portail-etu-direct', 'portail-etu directly'],
  ['ssh backup-target whoami', 'ssh <alias> whoami'],
  ['saved under F:/Programmation/x', 'saved under <home>/Programmation'],
  ['in C:\\Users\\me', 'in C:/Windows'],
  // A workflow input's description, as YAML writes it.
  [
    "description: 'e.g. http://192.168.1.32:8081'",
    "description: 'e.g. http://<workstation-lan-ip>:8081'",
  ],
  ['a Proxmox CT 101 guest', 'a Proxmox VM guest'],
];

/** Returns the label of every pattern that matches `text`. */
export function violations(text, patterns = PATTERNS) {
  return patterns.filter(([, re]) => re.test(text)).map(([label]) => label);
}

/**
 * Returns the comment text of a `.ts` / `.mjs` source: block comments, and `//` comments that start
 * a line or follow a separator (so the `//` of `https://` inside a string is not taken for one).
 */
export function commentsOf(source) {
  const out = [];
  for (const m of source.matchAll(/\/\*[\s\S]*?\*\//g)) out.push(m[0]);
  for (const m of source.matchAll(/(?:^|[\s;,{}()])\/\/(.*)$/gm)) out.push(m[1]);
  return out.join('\n');
}

/** Reads the out-of-repo denylist: one literal per line, `#` comments and blanks ignored. */
function loadDenylist() {
  const file = process.env.DOCS_PRIVATE_DENYLIST_FILE;
  if (!file) return null;
  if (!existsSync(file))
    throw new Error(`DOCS_PRIVATE_DENYLIST_FILE names a missing file: ${file}`);
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
}

const PENDING_CLEANUP = new Set([
  // Its offsite default is a live value the backup cron reads; moving it out of the tree changes
  // where the backup goes, so it waits for the owner's decision on where that value lives instead.
  'infrastructure/backup/backup-config.sh',
]);

let failed = 0;
const fail = (msg) => {
  failed += 1;
  console.error(`FAIL ${msg}`);
};

// Self-test: every line is flagged and every near-miss is not; and every pattern is LOAD-BEARING -
// without it, at least one line goes unflagged.
for (const [flagged, nearMiss] of COUNTER_CASES) {
  if (violations(flagged).length === 0) fail(`no pattern flags: ${flagged}`);
  if (violations(nearMiss).length > 0) fail(`a pattern flags the near-miss: ${nearMiss}`);
}
PATTERNS.forEach(([label, re], i) => {
  const others = PATTERNS.filter((_, j) => j !== i);
  if (!COUNTER_CASES.some(([flagged]) => violations(flagged, others).length === 0)) {
    fail(`pattern ${label} ${re} has no counter-case that only it flags`);
  }
});
for (const sample of ['ssh-keygen', 'port 3010', 'ssh keys']) {
  if (violations(sample).length > 0) fail(`pattern flagged a clean sample: ${sample}`);
}
if (!commentsOf("const u = 'https://10.0.0.4/x'; // see 10.0.0.5").includes('10.0.0.5')) {
  fail('commentsOf dropped a trailing // comment');
}
if (commentsOf("const u = 'https://10.0.0.4/x';").includes('10.0.0.4')) {
  fail('commentsOf took the // of a URL inside a string for a comment');
}
if (!commentsOf('/**\n * on 192.168.1.1\n */\nconst x = 1;').includes('192.168.1.1')) {
  fail('commentsOf dropped a block comment');
}

const tracked = (...globs) =>
  execFileSync('git', ['ls-files', '--', ...globs], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
const markdown = tracked('*.md');
const plain = tracked('*.env.example', '*.sh', '*.yml', '*.yaml');
const sources = tracked('*.ts', '*.mjs').filter((f) => f !== SELF);

const denylist = loadDenylist();
if (denylist === null) {
  console.error(
    'docs-private-guard: DENYLIST SKIPPED - DOCS_PRIVATE_DENYLIST_FILE is not set, so the named-infrastructure half of the scan did not run'
  );
}

for (const entry of PENDING_CLEANUP) {
  if (!existsSync(join(ROOT, entry))) fail(`PENDING_CLEANUP names a missing file: ${entry}`);
}
const scan = (file, text) => {
  if (PENDING_CLEANUP.has(file)) return;
  const found = violations(text);
  for (const word of denylist ?? []) {
    if (text.toLowerCase().includes(word.toLowerCase())) found.push('denylisted name');
  }
  if (found.length > 0)
    fail(`${file}: ${[...new Set(found)].join(', ')} (move it to the private notes)`);
};
for (const file of [...markdown, ...plain]) scan(file, readFileSync(join(ROOT, file), 'utf8'));
for (const file of sources) scan(file, commentsOf(readFileSync(join(ROOT, file), 'utf8')));

if (failed > 0) process.exit(1);
console.log(
  `docs-private-guard: ${markdown.length} markdown, ${plain.length} env/shell/yaml, ${sources.length} ts/mjs (comments) tracked files, ${PENDING_CLEANUP.size} pending cleanup, denylist ${denylist === null ? 'skipped' : `${denylist.length} entries`}`
);
