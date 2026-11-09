#!/usr/bin/env bun
/** The ratchet comparison: a raised count or a new entry fails; a lowered one or a removal passes. */
import assert from 'node:assert/strict';
import { ratchetRaises } from '../ratchet-not-raised.mjs';

const base = { 'a.svelte': { button: 2, select: 1, input: 0 }, 'b.svelte': { button: 1 } };

assert.deepEqual(ratchetRaises(base, base), [], 'identical passes');
assert.deepEqual(
  ratchetRaises(base, { 'a.svelte': { button: 1, select: 0, input: 0 } }),
  [],
  'lowering and removing an entry pass'
);
assert.equal(ratchetRaises(base, { ...base, 'a.svelte': { button: 3, select: 1, input: 0 } }).length, 1);
assert.match(
  ratchetRaises(base, { 'a.svelte': { button: 2, select: 1, input: 1 } })[0],
  /input raised 0 -> 1/
);
assert.match(ratchetRaises(base, { ...base, 'c.svelte': { button: 1 } })[0], /new entry/);
console.log('ratchet-not-raised.test.mjs: OK');
