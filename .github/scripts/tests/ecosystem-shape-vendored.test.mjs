#!/usr/bin/env bun
/**
 * THE VENDORED-COPY TABLE OF `tools/ecosystem-shape` NAMES REAL SOURCES AND REAL SITES.
 *
 * `shape.mjs` needs the four checkouts side by side and is run by hand, so a table entry that
 * names a source Canari no longer has, or a site the tool does not read, would only surface the
 * day somebody ran it. This test needs no sibling: it holds the table itself, so a typo or a moved
 * source fails `make test-ci-scripts`. The copies' own bytes are compared by the tool.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { HANDOFF_VENDORED, LEAVE_IAB_VENDORED } from '../../../tools/ecosystem-shape/vendored.mjs';

const repo = join(import.meta.dir, '..', '..', '..');
const shape = readFileSync(join(repo, 'tools/ecosystem-shape/shape.mjs'), 'utf8');
const labels = [...shape.matchAll(/^\s+\['([A-Za-z-]+)', '[^']+'\],$/gm)].map((m) => m[1]);

for (const [name, table] of [
  ['handoff', HANDOFF_VENDORED],
  ['leave-in-app-browser', LEAVE_IAB_VENDORED],
]) {
  for (const [source, sites] of table) {
    assert.ok(existsSync(join(repo, source)), `${name}: source ${source} does not exist in Canari`);
    for (const label of Object.keys(sites)) {
      assert.ok(labels.includes(label), `${name}: ${source} names ${label}, which shape.mjs does not read`);
    }
  }
}

// The gate is vendored whole: the three code files and the fixtures, in all three GitHub siblings.
assert.deepEqual(
  LEAVE_IAB_VENDORED.map(([source]) => source).sort(),
  ['detect.ts', 'fixtures.json', 'gate.ts', 'interstitial.html'].map((f) => `libs/leave-in-app-browser/${f}`)
);
for (const [source, sites] of LEAVE_IAB_VENDORED) {
  assert.deepEqual(Object.keys(sites).sort(), ['MiGallery', 'Portail-etu', 'Sky'], source);
}
console.log('ecosystem-shape vendored table: ok');
