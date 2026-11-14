#!/usr/bin/env bun
/**
 * EVERY THIRD-PARTY ACTION IS NAMED BY A COMMIT, WITH ITS VERSION BESIDE IT.
 *
 * A tag of an action is a name its publisher may move. A step that reads `uses: owner/action@v2`
 * runs whatever that name points at on the day of the run, with the job's token and secrets; a
 * commit id names one tree for ever. So an action published outside GitHub's own two organisations
 * (`actions/`, `github/`) is written `owner/action@<40 hex> # <version>`:
 *
 * - the commit is what runs;
 * - the comment is what a reader and Dependabot read: the `github-actions` ecosystem of
 *   `.github/dependabot.yml` moves the commit and the comment together, so a pin is updated by the
 *   same pull requests that moved the tag before.
 *
 * A local reference (`./.github/...`) is this repository at the same commit and needs no pin.
 *
 * A PIN NOTHING UPDATES IS FROZEN, so every directory that holds one is a directory Dependabot
 * reads: `/` covers `.github/workflows`, and a composite action under `.github/actions/<name>` is
 * read only when the `github-actions` entry names it (`/.github/actions/*` or the exact path).
 *
 * Usage: bun .github/scripts/tests/action-pins.test.mjs
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const FIRST_PARTY = /^(actions|github)\//;
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;

/** Every `uses:` of a workflow text, with its line number and what follows the reference. */
export function usesOf(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const match = /^\s*(?:-\s+)?uses:\s+(\S+)(.*)$/.exec(line);
    if (match) found.push({ line: index + 1, ref: match[1], rest: match[2] });
  });
  return found;
}

/** The directories the `github-actions` entry of a Dependabot file reads, as written. */
export function dependabotActionDirectories(text) {
  const start = text.search(/^\s*-\s+package-ecosystem:\s*["']?github-actions["']?\s*$/m);
  if (start < 0) return [];
  const rest = text.slice(start).split(/\r?\n/).slice(1);
  const end = rest.findIndex((line) => /^\s*-\s+package-ecosystem:/.test(line));
  const block = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  const many = /^\s*directories:\s*\[([^\]]*)\]/m.exec(block);
  const one = /^\s*directory:\s*(\S+)/m.exec(block);
  const raw = many ? many[1].split(',') : one ? [one[1]] : [];
  return raw.map((entry) => entry.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/** Whether Dependabot, reading `directories`, updates the pins of the repo-relative `file`. */
export function coveredByDependabot(file, directories) {
  const path = file.split('\\').join('/');
  if (path.startsWith('.github/workflows/')) return directories.includes('/');
  const action = /^(\.github\/actions)\/([^/]+)\/action\.ya?ml$/.exec(path);
  if (!action) return false;
  return directories.includes(`/${action[1]}/*`) || directories.includes(`/${action[1]}/${action[2]}`);
}

/** Why a reference is refused, or `null` when it is acceptable. */
export function refusal({ ref, rest }) {
  if (ref.startsWith('./') || FIRST_PARTY.test(ref)) return null;
  if (!PINNED.test(ref)) return 'is not pinned to a 40-character commit id';
  if (!/^\s+#\s+\S+/.test(rest)) return 'names a commit with no `# <version>` comment beside it';
  return null;
}

function workflowFiles() {
  const files = [];
  const workflows = join(ROOT, '.github', 'workflows');
  for (const name of readdirSync(workflows)) {
    if (/\.ya?ml$/.test(name)) files.push(join(workflows, name));
  }
  const actions = join(ROOT, '.github', 'actions');
  if (existsSync(actions)) {
    for (const name of readdirSync(actions)) {
      for (const file of ['action.yml', 'action.yaml']) {
        const path = join(actions, name, file);
        if (existsSync(path)) files.push(path);
      }
    }
  }
  return files;
}

let failed = 0;
const check = (ok, message) => {
  if (!ok) {
    failed += 1;
    console.error(`FAIL: ${message}`);
  }
};

// The reader itself, on what it must refuse and accept.
const SHA = 'a'.repeat(40);
const sample = usesOf(
  [
    'steps:',
    '  - uses: actions/checkout@v7',
    '  - name: x',
    '    uses: owner/tool@v2',
    `  - uses: owner/tool@${SHA}`,
    `  - uses: owner/tool/sub@${SHA} # v2.1.0`,
    '  - uses: ./.github/actions/local',
    `  - uses: owner/tool@${SHA.slice(0, 12)} # v2`,
    '  - uses: owner/tool@main # v2',
  ].join('\n')
);
check(sample.length === 7, `the reader finds 7 references in its sample, found ${sample.length}`);
check(
  JSON.stringify(sample.map((use) => refusal(use) === null)) ===
    JSON.stringify([true, false, false, true, true, false, false]),
  'the reader refuses a tag, a bare commit, a short commit and a branch, and accepts the rest'
);

// The cover reader, on what it must refuse and accept.
const sampleDirectories = dependabotActionDirectories(
  [
    'updates:',
    '  - package-ecosystem: "bun"',
    '    directory: "/frontend"',
    '  - package-ecosystem: "github-actions"',
    '    directories: ["/", "/.github/actions/*"]',
    '  - package-ecosystem: "cargo"',
    '    directory: "/apps"',
  ].join('\n')
);
check(
  JSON.stringify(sampleDirectories) === JSON.stringify(['/', '/.github/actions/*']),
  `the cover reader reads the github-actions entry alone, read ${JSON.stringify(sampleDirectories)}`
);
check(
  coveredByDependabot('.github/workflows/ci.yml', ['/']) &&
    !coveredByDependabot('.github/actions/x/action.yml', ['/']) &&
    coveredByDependabot('.github\\actions\\x\\action.yml', ['/', '/.github/actions/*']) &&
    coveredByDependabot('.github/actions/x/action.yml', ['/.github/actions/x']) &&
    !coveredByDependabot('.github/actions/y/action.yml', ['/.github/actions/x']),
  'the cover reader knows that `/` reads the workflows only'
);

// The workflows, and the Dependabot entry that keeps their pins moving.
const directories = dependabotActionDirectories(
  readFileSync(join(ROOT, '.github', 'dependabot.yml'), 'utf-8')
);
let thirdParty = 0;
const files = workflowFiles();
for (const file of files) {
  const relative = file.slice(ROOT.length + 1);
  let pinnedHere = 0;
  for (const use of usesOf(readFileSync(file, 'utf-8'))) {
    if (!use.ref.startsWith('./') && !FIRST_PARTY.test(use.ref)) {
      thirdParty += 1;
      pinnedHere += 1;
    }
    const why = refusal(use);
    check(why === null, `${relative}:${use.line} ${use.ref} ${why}`);
  }
  check(
    pinnedHere === 0 || coveredByDependabot(relative, directories),
    `${relative} holds ${pinnedHere} pinned action(s) and no directory of Dependabot's github-actions entry reads it (${JSON.stringify(directories)})`
  );
}
check(files.length > 0 && thirdParty > 0, 'the scan read no third-party reference at all');

/**
 * A PIN MOVES DEFAULTS TOO. `actions-rust-lang/setup-rust-toolchain` exports its `rustflags`
 * (`-D warnings`) and, from v2, its `build-warnings` (`CARGO_BUILD_WARNINGS=deny`) into
 * $GITHUB_ENV, so they reach every later step of the job - including a Tauri build whose vendored
 * path dependencies Cargo does not cap. Both are held empty on every use: v0.14.1's AppImage died
 * of the first, `1.6.12-alpha.1`'s iOS build of the second.
 */
const EXPORTED_LINT_INPUTS = ['rustflags', 'build-warnings'];

/** The `with:` keys of the step whose `uses:` sits at `line` (1-based), with their raw values. */
export function withInputsAt(text, line) {
  const lines = text.split(/\r?\n/);
  const inputs = {};
  let i = line;
  while (i < lines.length && !/^\s*with:\s*$/.test(lines[i]) && !/^\s*-\s/.test(lines[i])) i += 1;
  if (i >= lines.length || !/^\s*with:\s*$/.test(lines[i])) return inputs;
  const withIndent = lines[i].search(/\S/);
  for (i += 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (raw.search(/\S/) <= withIndent) break;
    const match = /^\s*([\w-]+):\s*(.*?)\s*$/.exec(raw);
    if (match) inputs[match[1]] = match[2];
  }
  return inputs;
}

{
  const sample = [
    '      - uses: actions-rust-lang/setup-rust-toolchain@x',
    '        with:',
    '          # a comment',
    "          rustflags: ''",
    '      - name: next',
    "        build-warnings: ''",
  ].join('\n');
  const read = withInputsAt(sample, 1);
  check(read.rustflags === "''", 'withInputsAt reads an input under with:');
  check(!('build-warnings' in read), 'withInputsAt stops at the next step');
}

let rustSetups = 0;
for (const file of files) {
  const relative = file.slice(ROOT.length + 1);
  const text = readFileSync(file, 'utf-8');
  for (const use of usesOf(text)) {
    if (!use.ref.startsWith('actions-rust-lang/setup-rust-toolchain@')) continue;
    rustSetups += 1;
    const inputs = withInputsAt(text, use.line);
    for (const name of EXPORTED_LINT_INPUTS) {
      check(
        inputs[name] === "''" || inputs[name] === '""',
        `${relative}:${use.line} setup-rust-toolchain must set \`${name}: ''\` - its default is exported to every later step of the job`
      );
    }
  }
}
check(rustSetups > 0, 'the scan found no setup-rust-toolchain use to hold');

if (failed > 0) {
  console.error(`action-pins: ${failed} failure(s)`);
  process.exit(1);
}
console.log(
  `OK: ${thirdParty} third-party action reference(s) in ${files.length} file(s), each pinned to a commit.`
);
