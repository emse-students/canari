/**
 * `deleteIndexedDbByName` ALWAYS resolves: a wipe walks on to its next step whatever one database
 * did. A `deleteDatabase` that throws synchronously (no IndexedDB in the realm, a storage the browser
 * shut) is a `false` with a log that accuses, never a rejection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteIndexedDbByName } from './indexedDbDelete';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('deleteIndexedDbByName', () => {
  it('resolves false, and logs, when deleteDatabase throws before any request exists', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('indexedDB', {
      deleteDatabase: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    await expect(deleteIndexedDbByName('CanariDBX', '[TEST]')).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith(
      '[TEST] could not ask for CanariDBX to be deleted:',
      expect.any(DOMException)
    );
  });

  it('resolves false, and logs, in a realm with no IndexedDB at all', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('indexedDB', undefined);
    await expect(deleteIndexedDbByName('CanariDBX', '[TEST]')).resolves.toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
