import { describe, expect, it, vi } from 'vitest';
import {
  notepadMessageId,
  runNotepadMigration,
  sha256HexOfText,
  type NotepadMigrationDeps,
  type NotepadRead,
} from './notepadMigration';

/**
 * The notepad's move into "Mes notes": the ORDER (posted and SENT before the server deletes it) and
 * the IDEMPOTENCE (a replay - a kill, another device - never posts a second copy, and never deletes
 * a notepad other than the one read). The server half is `users.service.spec.ts`.
 */
function makeDeps(over: Partial<NotepadMigrationDeps> = {}, read?: NotepadRead) {
  let marked = false;
  const order: string[] = [];
  const deps: NotepadMigrationDeps = {
    userId: 'u1',
    readNotepad: vi.fn(
      async (): Promise<NotepadRead> =>
        read ?? { kind: 'held', text: 'my list', digest: 'd'.repeat(64) }
    ),
    ensureSelfConversation: vi.fn(async () => ({ key: 'self-group' })),
    heldAs: vi.fn(async () => null),
    send: vi.fn(async () => {
      order.push('send');
      return 'sent' as const;
    }),
    confirmMoved: vi.fn(async () => {
      order.push('delete');
      return 'moved' as const;
    }),
    doneMark: {
      read: () => marked,
      write: () => {
        marked = true;
      },
    },
    log: () => undefined,
    ...over,
  };
  return { deps, order, isMarked: () => marked };
}

describe('notepadMessageId', () => {
  it('is the same for the same account and notepad, on every device and every replay', async () => {
    const a = await notepadMessageId('u1', 'd'.repeat(64));
    expect(await notepadMessageId('u1', 'd'.repeat(64))).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('differs for another notepad or another account', async () => {
    const a = await notepadMessageId('u1', 'd'.repeat(64));
    expect(await notepadMessageId('u1', 'e'.repeat(64))).not.toBe(a);
    expect(await notepadMessageId('u2', 'd'.repeat(64))).not.toBe(a);
  });
});

describe('runNotepadMigration', () => {
  it('posts the notepad into "Mes notes", and deletes it on the server only once it is sent', async () => {
    const { deps, order, isMarked } = makeDeps();
    await expect(runNotepadMigration(deps)).resolves.toBe('moved');
    expect(order).toEqual(['send', 'delete']);
    const [text, key, id] = vi.mocked(deps.send).mock.calls[0];
    expect(text).toContain('my list');
    expect(key).toBe('self-group');
    expect(id).toBe(await notepadMessageId('u1', 'd'.repeat(64)));
    expect(deps.confirmMoved).toHaveBeenCalledWith('d'.repeat(64));
    expect(isMarked()).toBe(true);
  });

  it('keeps the notepad on the server while the message is only queued', async () => {
    const { deps, isMarked } = makeDeps({ send: vi.fn(async () => 'pending' as const) });
    await expect(runNotepadMigration(deps)).resolves.toBe('posting');
    expect(deps.confirmMoved).not.toHaveBeenCalled();
    expect(isMarked()).toBe(false);
  });

  it('a replay after a kill finds its message held and never queues a second copy', async () => {
    // Killed after the send, before the delete: the message is in this device's store.
    const { deps, order } = makeDeps({ heldAs: vi.fn(async () => 'sent' as const) });
    await expect(runNotepadMigration(deps)).resolves.toBe('moved');
    expect(deps.send).not.toHaveBeenCalled();
    expect(order).toEqual(['delete']);
  });

  it('a replay whose copy is still queued waits for it and sends nothing new', async () => {
    const { deps } = makeDeps({ heldAs: vi.fn(async () => 'pending' as const) });
    await expect(runNotepadMigration(deps)).resolves.toBe('posting');
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.confirmMoved).not.toHaveBeenCalled();
  });

  it('stops for good when the server holds no notepad, and asks nothing more afterwards', async () => {
    const { deps, isMarked } = makeDeps({}, { kind: 'moved' });
    await expect(runNotepadMigration(deps)).resolves.toBe('nothing-held');
    expect(deps.ensureSelfConversation).not.toHaveBeenCalled();
    expect(isMarked()).toBe(true);
    await expect(runNotepadMigration(deps)).resolves.toBe('done-before');
    expect(deps.readNotepad).toHaveBeenCalledTimes(1);
  });

  it('waits while "Mes notes" is arriving from another device - nothing posted, nothing deleted', async () => {
    const { deps } = makeDeps({
      ensureSelfConversation: vi.fn(async () => ({ waiting: 'self-conversation-arriving' })),
    });
    await expect(runNotepadMigration(deps)).resolves.toBe('waiting-for-notes');
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.confirmMoved).not.toHaveBeenCalled();
  });

  it('reads again next run when the server holds another notepad than the one moved', async () => {
    const { deps, isMarked } = makeDeps({ confirmMoved: vi.fn(async () => 'changed' as const) });
    await expect(runNotepadMigration(deps)).resolves.toBe('changed');
    expect(isMarked()).toBe(false);
  });

  it('deletes a blank notepad without posting a message', async () => {
    const { deps } = makeDeps({}, { kind: 'held', text: '  \n', digest: 'b'.repeat(64) });
    await expect(runNotepadMigration(deps)).resolves.toBe('moved');
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.confirmMoved).toHaveBeenCalledWith('b'.repeat(64));
  });

  it('keeps everything when the read has no answer, and says so', async () => {
    const log = vi.fn();
    const { deps } = makeDeps({
      log,
      readNotepad: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await expect(runNotepadMigration(deps)).resolves.toBe('unanswered');
    expect(deps.confirmMoved).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stays on the server'));
  });
});

describe('sha256HexOfText', () => {
  it('is the hex SHA-256 the server computes over the same UTF-8 string', async () => {
    expect(await sha256HexOfText('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});
