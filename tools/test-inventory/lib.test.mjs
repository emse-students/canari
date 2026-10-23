#!/usr/bin/env bun
/**
 * THE INVENTORY'S READINGS, PINNED ON STRINGS.
 *
 * An inventory that miscounts is worse than none: it is the number the reform is judged by. Each
 * case below is a shape that really occurs in this repository (a multi-line `it.each`, a skipped
 * case, a docblock opening with a table) and a reading that was wrong on a first draft.
 *
 * Usage: bun tools/test-inventory/lib.test.mjs   (no arguments, no network)
 */
import assert from 'node:assert/strict';
import {
  appImports,
  backtickedDirs,
  backtickedStems,
  bodyKey,
  classifyTextReads,
  derivePurpose,
  failedPathsInLog,
  hasAssertion,
  isConstantMirror,
  looksLikeFix,
  parseJsTests,
  parseRustTests,
  stemOf,
} from './lib.mjs';

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`);
  }
}

const sample = [
  "describe('thing', () => {",
  "  it('does a', () => {",
  '    expect(a()).toBe(1);',
  '  });',
  "  it.skip('is parked', () => {});",
  '  it.each([',
  "    ['x', 1],",
  "  ])('each %s', (k, v) => {",
  '    expect(f(k)).toBe(v);',
  '  });',
  '  const item = 3;',
  "  test.todo('later');",
  '});',
].join('\n');

check('counts cases, skipped, dynamic, and ignores identifiers that start with it', () => {
  const r = parseJsTests(sample);
  assert.equal(r.cases.length, 4);
  assert.equal(r.cases.filter((c) => c.skipped).length, 2);
  assert.equal(r.cases.filter((c) => c.dynamic).length, 1);
  assert.deepEqual(r.describes, ['thing']);
});

check('a multi-line it.each keeps its body to the closing call', () => {
  const each = parseJsTests(sample).cases.find((c) => c.dynamic);
  assert.ok(each.body.includes('expect(f(k)).toBe(v)'));
  assert.ok(hasAssertion(each.body));
});

check('a case with no expect is hollow, a helper assertion is not', () => {
  assert.equal(hasAssertion("it('x', () => {\n  run();\n});"), false);
  assert.equal(hasAssertion("it('x', () => {\n  expectRefused(run());\n});"), true);
  assert.equal(
    hasAssertion("it('x', async () => {\n  await promise.rejects.toThrow();\n});"),
    true
  );
});

check('the same body in two files has one key, whitespace and comments aside', () => {
  const a = "it('one', () => {\n  // why\n  expect(f( 1 )).toBe(2);\n});";
  const b = "it('two', () => {\n    expect(f( 1 )).toBe(2);\n});";
  assert.equal(bodyKey(a), bodyKey(b));
});

check('a constant mirror is only expect(name).toBe(literal)', () => {
  assert.equal(isConstantMirror("it('x', () => {\n  expect(LIMIT).toBe(10);\n});"), true);
  assert.equal(isConstantMirror("it('x', () => {\n  expect(f(1)).toBe(10);\n});"), false);
  assert.equal(
    isConstantMirror("it('x', () => {\n  const a = f();\n  expect(a).toBe(10);\n});"),
    false
  );
});

check('Rust: counts #[test] and #[tokio::test], and #[ignore]', () => {
  const r = parseRustTests(
    '#[test]\nfn a() {}\n#[tokio::test]\nasync fn b() {}\n#[test]\n#[ignore = "slow"]\nfn c() {}\n'
  );
  assert.equal(r.cases, 3);
  assert.equal(r.ignored, 1);
});

check('purpose: docblock first sentence, then describe names, then unknown', () => {
  assert.equal(
    derivePurpose('/**\n * THE GATE THAT MATTERS.\n *\n * More.\n */\nimport x', [], []).purpose,
    'THE GATE THAT MATTERS.'
  );
  assert.equal(derivePurpose('import x', ['A thing', 'B'], []).source, 'describe');
  assert.equal(derivePurpose('import x', [], ['does it']).source, 'cases');
  assert.equal(derivePurpose('import x', [], []).purpose, 'unknown');
});

check('purpose: a docblock that comes after the imports is found', () => {
  const text = [
    "import { a } from './a';",
    '',
    '/**',
    ' * GUARDRAIL ON THE TRANSLATION FILES.',
    ' */',
    'const x = 1;',
  ].join('\n');
  const p = derivePurpose(text, [], []);
  assert.equal(p.purpose, 'GUARDRAIL ON THE TRANSLATION FILES.');
});

check('purpose: a script comment header is read, the usage line is not', () => {
  const p = derivePurpose(
    '#!/usr/bin/env bash\n# =====\n# WHICH ESTATE A URL NAMES.\n# more\n# =====\nset -u',
    [],
    []
  );
  assert.equal(p.source, 'docblock');
  assert.ok(p.purpose.startsWith('WHICH ESTATE'));
});

check('source-text classification by the extension a read names', () => {
  assert.equal(
    classifyTextReads("readFileSync(join(ROOT, 'src/app.css'), 'utf8')").kind,
    'app-source'
  );
  assert.equal(
    classifyTextReads("readFileSync(join(ROOT, 'android/Foo.kt'), 'utf8')").kind,
    'native-contract'
  );
  assert.equal(
    classifyTextReads("readFileSync(join(ROOT, 'docs/wiki/x.md'), 'utf8')").kind,
    'docs-ci'
  );
  assert.equal(classifyTextReads('expect(1).toBe(1)').readsFiles, false);
});

check('app imports ignore node, vitest and npm packages', () => {
  const t =
    "import { it } from 'vitest';\nimport { readFileSync } from 'node:fs';\nimport x from 'lodash';\nimport { a } from './a';\nimport { b } from '$lib/b';\nimport { f } from '../../test/flush';";
  assert.deepEqual(appImports(t), ['./a', '$lib/b']);
});

check('WP-T5 keep list: families and directories', () => {
  const md =
    'kept: `useNotifications.webClick/.tapListener`, `serverProse`, and `styles/*`, `outbox`.';
  const stems = backtickedStems(md);
  assert.ok(stems.has('useNotifications'));
  assert.ok(stems.has('serverProse'));
  assert.ok(backtickedDirs(md).has('styles'));
  assert.equal(stemOf('a/b/AssociationTile.render.svelte.test.ts'), 'AssociationTile');
});

check('a fix commit is recognised by its subject', () => {
  assert.equal(looksLikeFix('fix(push): an account deletion removes its copies (#2100)'), true);
  assert.equal(looksLikeFix('revert: the tab swipe'), true);
  assert.equal(looksLikeFix('feat(reels): a rail'), false);
  assert.equal(looksLikeFix('chore: bump version to 1.3.0-alpha.3'), false);
});

check('failed test files are read out of a CI log', () => {
  const log =
    ' FAIL  src/lib/utils/chat/outbox.test.ts > flushes\n × something\nFAIL src/auth/auth.controller.spec.ts\nok  src/lib/other.test.ts';
  assert.deepEqual(failedPathsInLog(log).sort(), [
    'src/auth/auth.controller.spec.ts',
    'src/lib/utils/chat/outbox.test.ts',
  ]);
});

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('test-inventory lib: all checks passed');
