import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ONE PLACE DECIDES WHICH STORE A DEVICE HAS, AND IT IS `getStorage`.
 *
 * The two backends are not interchangeable and the difference is invisible at the call site. On the
 * web the message store is `CanariDB_<userId>` in IndexedDB; inside Tauri it is a SQLite file in the
 * app data directory, and the MLS state persister writes `mls.bin` to the filesystem next to it
 * without consulting this choice. So a call site that names a backend itself does not merely pick a
 * slower path - it picks a DIFFERENT DEVICE.
 *
 * That is not hypothetical. `ConversationsMiniPanel` built an `IndexedDbStorage` directly, and on a
 * Pixel 6a measured on 2026-08-28 the consequences were both halves of the same mistake:
 *
 *   - it READ a store the phone does not write, so the posts sidebar answered from an unrelated
 *     database while the chat answered from SQLite;
 *   - and `init()` CREATED that database by opening it - 5.9 MB of it - on a platform where the
 *     factory wipe deleted `mls.bin` and the `.db` files and never touched the WebView, so a device
 *     its owner had revoked kept its conversation list.
 *
 * The wipe is fixed to clear both, because a WebView exists on every platform. This test fixes the
 * cause: nothing outside `db.ts` may name a backend.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../..');

/** `new IndexedDbStorage(` / `new SqliteStorage(` - a backend chosen by hand. */
const NAMES_A_BACKEND = /\bnew\s+(IndexedDbStorage|SqliteStorage)\s*\(/;

/**
 * `db.ts` is the factory and is the one file allowed to construct both.
 *
 * `db/indexeddb.ts` and `db/sqlite.ts` declare the classes and do not construct them, so they are
 * not exceptions - if either ever does, this test should be the thing that asks why.
 */
const ALLOWED = new Set(['lib/db.ts']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'paraglide' || entry === 'node_modules') continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|svelte)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('the storage backend is chosen in one place', () => {
  it('has no call site outside db.ts naming a backend directly', () => {
    const offenders = sourceFiles(SRC)
      .map((file) => relative(SRC, file).replace(/\\/g, '/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => NAMES_A_BACKEND.test(readFileSync(resolve(SRC, rel), 'utf8')));

    expect(
      offenders,
      `Call await getStorage(userId) from $lib/db instead. Naming a backend picks a different ` +
        `DEVICE: inside Tauri the messages live in SQLite and the MLS state in mls.bin, so an ` +
        `IndexedDbStorage there reads a store nothing writes and creates one the factory wipe was ` +
        `not clearing - which is how a revoked phone kept 5.9 MB of its conversations.`
    ).toEqual([]);
  });
});
