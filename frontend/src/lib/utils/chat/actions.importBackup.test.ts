/**
 * A BACKUP IMPORT'S OUTCOME IS THE STORE MERGE (review of #3887). The import no longer clears the
 * conversation map - a frame meeting the empty map in between was handled as one the reader had
 * deleted - and asks the session's own restore instead. That restore may fail on its own (a group
 * list the server did not answer): it is then the RESTORE's failure, said as such, never reported as
 * the import's - the reader would import again a file that is already in.
 */
import { describe, expect, it, vi } from 'vitest';

const { importBackup } = vi.hoisted(() => ({ importBackup: vi.fn() }));
vi.mock('$lib/backup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/backup')>();
  return { ...actual, importBackup };
});

import { importUserBackup } from './actions';
import { restoreAfterImport } from '$lib/composables/session/sessionBackup';
import type { IStorage } from '$lib/db';

/** One imported conversation and two messages, from another device (no MLS state to restore). */
function importedOnce(): void {
  importBackup.mockResolvedValueOnce({
    data: { conversations: [{ id: 'c' }], messages: [{ id: 'a' }, { id: 'b' }] },
    isSameDevice: false,
    mlsStateUsable: false,
  });
}

function run(reloadConversations: () => Promise<void>, log = vi.fn()) {
  return importUserBackup({
    file: new File([new Uint8Array([1])], 'backup.canari'),
    deviceKeyB64: 'device-key',
    storage: {} as IStorage,
    myDeviceId: 'device',
    userId: 'me',
    log,
    reloadConversations,
  });
}

describe('a backup import and the restore it asks for', () => {
  it('a restore that REJECTS leaves the import successful, and is said as the restore failing', async () => {
    importedOnce();
    const log = vi.fn();
    const outcome = await run(() => Promise.reject(new Error('groups unavailable')), log);

    expect(outcome).toEqual({ conversations: 1, messages: 2, isSameDevice: false });
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(
      lines.some(
        (line) =>
          line.includes(
            'the backup is imported, but the conversation list could not be restored'
          ) && line.includes('groups unavailable')
      )
    ).toBe(true);
    expect(lines.some((line) => line.startsWith('[OK] Backup imported'))).toBe(true);
  });

  it("WITH session callbacks: the import runs the session's own restore, once, and nothing clears the map", async () => {
    importedOnce();
    const loadAndRestoreConversations = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    await run(
      restoreAfterImport(() => ({ loadAndRestoreConversations }), log),
      log
    );
    expect(loadAndRestoreConversations).toHaveBeenCalledTimes(1);
  });

  it('WITHOUT session callbacks (a follower tab): the import succeeds and says the list restores at the next pass', async () => {
    importedOnce();
    const log = vi.fn();
    const outcome = await run(
      restoreAfterImport(() => null, log),
      log
    );
    expect(outcome.conversations).toBe(1);
    expect(
      log.mock.calls.some((call) =>
        String(call[0]).includes('restores its list at its next restore')
      )
    ).toBe(true);
  });
});
