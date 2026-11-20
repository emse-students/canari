import { ACCOUNT_KEY, accountLocalStorageKeysIn } from './accountLocalKeys';

/**
 * EVERY KEY `ACCOUNT_KEY` BUILDS IS ONE AN ACCOUNT DELETION SWEEPS.
 *
 * The builders and the sweep's allowlist (`exactKeys`, `keyPrefixes`) are two lists in one file, and
 * nothing tied them: `pinProven` was added to the first and not the second, so a deletion or a device
 * wipe left it behind (review of #3909, 2026-11-20). This walks the builders themselves - a new one
 * that the sweep does not cover fails here, by name.
 */
function storageOf(keys: string[]): Storage {
  const entries = new Map(keys.map((key) => [key, '1']));
  return {
    get length() {
      return entries.size;
    },
    key: (i: number) => [...entries.keys()][i] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
  };
}

describe('accountLocalStorageKeysIn', () => {
  const userId = 'user-1';
  /** Each builder's key for `userId`; a two-part key gets a second part with no `_` or `:`. */
  const built = Object.entries(ACCOUNT_KEY).map(([name, build]) => ({
    name,
    key: (build as (id: string, part: string) => string)(userId, 'part1'),
  }));

  it('covers the key of EVERY builder of ACCOUNT_KEY', () => {
    const swept = new Set(accountLocalStorageKeysIn(storageOf(built.map((b) => b.key)), userId));
    expect(built.filter((b) => !swept.has(b.key)).map((b) => b.name)).toEqual([]);
  });

  it('sweeps none of them for another account', () => {
    expect(accountLocalStorageKeysIn(storageOf(built.map((b) => b.key)), 'user-2')).toEqual([]);
  });
});
