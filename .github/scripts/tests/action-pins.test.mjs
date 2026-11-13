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

// The workflows.
let thirdParty = 0;
const files = workflowFiles();
for (const file of files) {
  for (const use of usesOf(readFileSync(file, 'utf-8'))) {
    if (!use.ref.startsWith('./') && !FIRST_PARTY.test(use.ref)) thirdParty += 1;
    const why = refusal(use);
    check(why === null, `${file.slice(ROOT.length + 1)}:${use.line} ${use.ref} ${why}`);
  }
}
check(files.length > 0 && thirdParty > 0, 'the scan read no third-party reference at all');

if (failed > 0) {
  console.error(`action-pins: ${failed} failure(s)`);
  process.exit(1);
}
console.log(
  `OK: ${thirdParty} third-party action reference(s) in ${files.length} file(s), each pinned to a commit.`
);
