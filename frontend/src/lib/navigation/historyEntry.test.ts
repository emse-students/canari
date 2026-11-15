// @vitest-environment happy-dom
/**
 * THE KEY OF A HISTORY ENTRY is SvelteKit's `navigationIndex`, read out of `history.state`.
 *
 * That field is not public API, so the first test reads SvelteKit's own source for the two names this
 * module depends on: an upgrade that renames either fails HERE instead of silently emptying the
 * Back-arrow memory and the scroll memory.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HISTORY_METADATA_KEY,
  arriveAtEntry,
  currentEntryKey,
  entryKeyOf,
  memoryFor,
  memoryOf,
  resetEntryMemory,
} from './historyEntry';

const kit = resolve(__dirname, '../../../node_modules/@sveltejs/kit/src/runtime/client');

afterEach(resetEntryMemory);

describe('the SvelteKit contract this module reads', () => {
  it('names the metadata key and the navigationIndex field the way SvelteKit writes them', () => {
    const constants = readFileSync(resolve(kit, 'constants.js'), 'utf8');
    expect(constants).toContain(`HISTORY_METADATA_KEY = '${HISTORY_METADATA_KEY}'`);
    expect(readFileSync(resolve(kit, 'client.js'), 'utf8')).toContain('navigationIndex');
  });
});

describe('entryKeyOf', () => {
  it('reads the index, and nothing from a state SvelteKit did not write', () => {
    expect(entryKeyOf({ [HISTORY_METADATA_KEY]: { navigationIndex: 7 } })).toBe(7);
    expect(entryKeyOf(null)).toBeUndefined();
    expect(entryKeyOf({})).toBeUndefined();
    expect(entryKeyOf({ [HISTORY_METADATA_KEY]: { navigationIndex: '7' } })).toBeUndefined();
  });
});

describe('arriveAtEntry', () => {
  const at = (n: number) => ({ [HISTORY_METADATA_KEY]: { navigationIndex: n } });

  it('is a REPLACE exactly when the key did not move', () => {
    expect(arriveAtEntry(at(5))).toEqual({ key: 5, replaced: false });
    expect(arriveAtEntry(at(6))).toEqual({ key: 6, replaced: false });
    expect(arriveAtEntry(at(6))).toEqual({ key: 6, replaced: true });
    expect(currentEntryKey()).toBe(6);
  });

  it('keeps a memory per entry, never per address', () => {
    memoryFor(1).top = 100;
    memoryFor(2).top = 900;
    expect(memoryOf(1)?.top).toBe(100);
    expect(memoryOf(2)?.top).toBe(900);
  });

  it('answers with no key for a state SvelteKit did not write', () => {
    expect(arriveAtEntry(null)).toEqual({ key: undefined, replaced: false });
    expect(currentEntryKey()).toBeUndefined();
  });
});
