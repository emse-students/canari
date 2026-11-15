#!/usr/bin/env bun
/**
 * THE DEAD-CODE RATCHET MUST REFUSE A RISE, REFUSE A GAIN THAT IS NOT LOCKED, AND READ KNIP'S REPORT.
 *
 * `dead-code-ratchet.mjs` is the gate that keeps a swept codebase swept, so a gate that passes
 * on a rise is the failure to rule out. Each case feeds the pure functions one situation; the last
 * pins that `ci.yml` calls the script and that the baseline names every category the script counts
 * (a category missing from the baseline would be allowed 0 silently, which is correct, but one the
 * script stopped counting would pass for ever).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareToBaseline,
  KNIP_CATEGORIES,
  readJsonIfPresent,
  sourceTokens,
  summariseKnip,
  unusedMessageKeys,
} from '../dead-code-ratchet.mjs';

let failures = 0;
const ok = (what, cond) => {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`);
};

console.log('summariseKnip');
const report = {
  issues: [
    { file: 'src/a.ts', exports: [{ name: 'one' }, { name: 'two' }], types: [{ name: 'T' }] },
    { file: 'src/b.ts', files: [{ name: 'src/b.ts' }], exports: [] },
    { file: 'package.json', devDependencies: [{ name: 'left-pad' }] },
  ],
};
const summary = summariseKnip(report);
ok('exports are counted across files', summary.counts.exports === 2);
ok('types are counted', summary.counts.types === 1);
ok('a category knip left empty is zero', summary.counts.duplicates === 0);
ok('items name the file and the symbol', summary.items.exports[0] === 'src/a.ts: one');
ok('a dev dependency is counted', summary.counts.devDependencies === 1);

console.log('compareToBaseline');
ok('equal passes', compareToBaseline({ exports: 3 }, { exports: 3 }).raised.length === 0);
ok('a rise is raised', compareToBaseline({ exports: 3 }, { exports: 4 }).raised[0] === 'exports');
ok(
  'a gain is lowered, not raised',
  compareToBaseline({ exports: 3 }, { exports: 2 }).lowered[0] === 'exports'
);
ok(
  'a label the baseline lacks is allowed zero',
  compareToBaseline({}, { types: 1 }).raised[0] === 'types'
);

console.log('unused translation keys');
const dir = mkdtempSync(join(tmpdir(), 'dead-code-'));
try {
  mkdirSync(join(dir, 'paraglide'), { recursive: true });
  writeFileSync(
    join(dir, 'a.ts'),
    "import { m } from '$lib/paraglide/messages';\nm.used_key();\nconst x = { labelKey: 'named_in_string' };\n"
  );
  writeFileSync(join(dir, 'paraglide', 'generated.js'), 'export const generated_only_key = 1;\n');
  const tokens = sourceTokens(dir);
  const keys = ['used_key', 'named_in_string', 'generated_only_key', 'reached_by_hand'];
  ok('a key called as m.key() is used', !unusedMessageKeys(keys, tokens, {}).includes('used_key'));
  ok(
    'a key named in a string is used',
    !unusedMessageKeys(keys, tokens, {}).includes('named_in_string')
  );
  ok(
    'the generated Paraglide output does not count as a use',
    unusedMessageKeys(keys, tokens, {}).includes('generated_only_key')
  );
  ok(
    'an allow-listed key is not reported',
    !unusedMessageKeys(keys, tokens, { reached_by_hand: 'why' }).includes('reached_by_hand')
  );
  writeFileSync(join(dir, 'present.json'), '{ "messages": { "k": "why" } }');
  ok(
    'readJsonIfPresent parses a present file',
    readJsonIfPresent(join(dir, 'present.json'))?.messages?.k === 'why'
  );
  ok('readJsonIfPresent returns null for a missing file', readJsonIfPresent(join(dir, 'no.json')) === null);
  let threw = false;
  writeFileSync(join(dir, 'broken.json'), '{');
  try {
    readJsonIfPresent(join(dir, 'broken.json'));
  } catch {
    threw = true;
  }
  ok('readJsonIfPresent still throws on a malformed file', threw);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('wiring');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
ok('ci.yml runs the ratchet', ci.includes('.github/scripts/dead-code-ratchet.mjs frontend'));
const baseline = JSON.parse(readFileSync(join(root, 'frontend/dead-code-baseline.json'), 'utf8'));
ok(
  'the baseline names every counted category and the messages',
  [...KNIP_CATEGORIES, 'messages'].every((c) => typeof baseline[c] === 'number')
);

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
