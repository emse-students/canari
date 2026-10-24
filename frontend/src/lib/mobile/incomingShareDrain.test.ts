const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { drainNativeShare, stageSharedFiles } from './incomingShareDrain';
import { parseSharedManifest } from './sharedInbox';
import { incomingShare } from '$lib/stores/incomingShare.svelte';

/**
 * The native share manifest is written by another layer (`IncomingShare.kt`) and read here: a
 * malformed one must be dropped rather than half-offered, and every item that does not reach the
 * composer must be COUNTED, because the member was shown nothing else that would say so.
 */
describe('parseSharedManifest', () => {
  it('reads text, files, the refused count and the capture epoch', () => {
    const parsed = parseSharedManifest(
      JSON.stringify({
        id: 'x',
        text: 'hi',
        files: [{ path: '/c/0_a.png', name: 'a.png', mime: 'image/png', size: 3 }],
        refused: 2,
        epoch: 5,
      })
    );
    expect(parsed).toEqual({
      text: 'hi',
      files: [{ path: '/c/0_a.png', name: 'a.png', mime: 'image/png', size: 3 }],
      refused: 2,
      epoch: 5,
      target: null,
    });
  });

  it('keeps the share-sheet suggestion as a conversation id, and ignores a malformed one', () => {
    const target = (value: unknown) =>
      parseSharedManifest(JSON.stringify({ text: 'hi', target: value }))?.target;
    expect(target('c:0f8b8f8e-6d1c-4b3e-9a51-2d4f1c9e7a10')).toBe(
      '0f8b8f8e-6d1c-4b3e-9a51-2d4f1c9e7a10'
    );
    expect(target('chat_0f8b8f8e')).toBeNull();
    expect(target('c:../mls.bin')).toBeNull();
    expect(target(42)).toBeNull();
    expect(target(undefined)).toBeNull();
  });

  it('keeps only well-formed file entries', () => {
    const parsed = parseSharedManifest(
      JSON.stringify({
        files: [
          { path: '/c/a' },
          null,
          'x',
          { path: '/c/n', name: 'n', mime: 'text/plain' },
          { path: '/c/b', name: 'b', mime: 'text/plain', size: 0 },
        ],
      })
    );
    expect(parsed?.files.map((f) => f.name)).toEqual(['b']);
    expect(parsed?.text).toBe('');
    expect(parsed?.refused).toBe(0);
  });

  it('drops unreadable JSON and non-objects', () => {
    expect(parseSharedManifest('{')).toBeNull();
    expect(parseSharedManifest('null')).toBeNull();
    expect(parseSharedManifest('3')).toBeNull();
  });
});

describe('drainNativeShare', () => {
  beforeEach(() => {
    invoke.mockReset();
    incomingShare.cancel();
  });

  it('answers null and offers nothing when no share waits', async () => {
    invoke.mockResolvedValueOnce(null);
    expect(await drainNativeShare()).toBeNull();
    expect(incomingShare.pending).toBeNull();
  });

  it('offers the text and the file NAMES, and reads no bytes before staging', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_and_clear_pending_share') {
        return {
          manifest: JSON.stringify({
            text: 'look',
            files: [{ path: '/c/0_a.png', name: 'a.png', mime: 'image/png', size: 3 }],
            refused: 1,
          }),
          epoch: 0,
        };
      }
      return undefined;
    });
    expect(await drainNativeShare()).toEqual({ lost: 1 });
    expect(incomingShare.pending).toEqual({
      text: 'look',
      files: [{ path: '/c/0_a.png', name: 'a.png', mime: 'image/png', size: 3 }],
      suggested: null,
    });
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'take_picked_file')).toEqual([]);
  });

  it('hands the suggestion to the store as a hint', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'read_and_clear_pending_share'
        ? {
            manifest: JSON.stringify({ text: 'look', files: [], refused: 0, target: 'c:abc' }),
            epoch: 0,
          }
        : undefined
    );
    await drainNativeShare();
    expect(incomingShare.pending?.suggested).toBe('abc');
  });

  it('counts a corrupt manifest as one lost share', async () => {
    invoke.mockResolvedValueOnce({ manifest: '{not json', epoch: 0 });
    expect(await drainNativeShare()).toEqual({ lost: 1 });
    expect(incomingShare.pending).toBeNull();
  });

  it('deletes a manifest captured before a sign-out, offers and reports nothing of it', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'read_and_clear_pending_share'
        ? {
            manifest: JSON.stringify({
              text: 'old',
              files: [{ path: '/c/0_a.png', name: 'a.png', mime: 'image/png', size: 3 }],
              refused: 2,
              epoch: 3,
            }),
            epoch: 4,
          }
        : undefined
    );
    expect(await drainNativeShare()).toBeNull();
    expect(incomingShare.pending).toBeNull();
    expect(invoke.mock.calls).toContainEqual(['discard_picked_file', { path: '/c/0_a.png' }]);
  });
});

describe('stageSharedFiles', () => {
  beforeEach(() => invoke.mockReset());

  const MB = 1024 * 1024;
  const limits = { maxPlaintextBytes: 50 * MB };

  it('reads and stages one copy at a time, and counts the ones lost', async () => {
    const order: string[] = [];
    // Only the share's commands are answered: the logger reaches `invoke` too, and refusing its
    // command would fail the test on a rejection nothing under test owns.
    invoke.mockImplementation(async (cmd: string, args?: { path: string }) => {
      if (cmd !== 'take_picked_file') return undefined;
      order.push(`read ${args?.path}`);
      if (args?.path === '/c/1_b.pdf') throw new Error('path outside the picker directories');
      return new ArrayBuffer(3);
    });
    const result = await stageSharedFiles(
      [
        { path: '/c/0_a.png', name: 'a.png', mime: 'image/png', size: 3 },
        { path: '/c/1_b.pdf', name: 'b.pdf', mime: 'application/pdf', size: 3 },
        { path: '/c/2_c.png', name: 'c.png', mime: 'image/png', size: 3 },
      ],
      'g',
      limits,
      async (file) => {
        order.push(`stage ${file.name} ${file.type} ${file.size}`);
      }
    );
    expect(result).toEqual({ staged: 2, lost: 1, tooLarge: [] });
    // Each copy is staged before the next is read: the WebView holds one share file at a time.
    expect(order).toEqual([
      'read /c/0_a.png',
      'stage a.png image/png 3',
      'read /c/1_b.pdf',
      'read /c/2_c.png',
      'stage c.png image/png 3',
    ]);
  });

  it('holds a non-video to the COMPOSER ceiling and deletes it unread; a video goes to the encoder', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'take_picked_file' ? new ArrayBuffer(1) : undefined
    );
    const pdf = { path: '/c/0_big.pdf', name: 'big.pdf', mime: 'application/pdf', size: 150 * MB };
    const video = { path: '/c/1_v.mp4', name: 'v.mp4', mime: 'video/mp4', size: 150 * MB };
    const staged: string[] = [];
    const result = await stageSharedFiles([pdf, video], 'g', limits, async (file) => {
      staged.push(file.name);
    });
    expect(result.tooLarge).toEqual([pdf]);
    expect(staged).toEqual(['v.mp4']);
    const calls = invoke.mock.calls.filter(([cmd]) => cmd !== 'plugin:log|log');
    expect(calls).toContainEqual(['discard_picked_file', { path: '/c/0_big.pdf' }]);
    expect(calls).not.toContainEqual(['take_picked_file', { path: '/c/0_big.pdf' }]);
  });

  it('applies exactly the predicate the composer applies to a picked file', async () => {
    // The boundary is the server's plaintext ceiling: at it a copy is read, one byte over it is not.
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'take_picked_file' ? new ArrayBuffer(1) : undefined
    );
    const at = { path: '/c/0_at', name: 'at', mime: 'application/pdf', size: 50 * MB };
    const over = { path: '/c/1_over', name: 'over', mime: 'application/pdf', size: 50 * MB + 1 };
    const result = await stageSharedFiles([at, over], 'g', limits, async () => {});
    expect(result.staged).toBe(1);
    expect(result.tooLarge).toEqual([over]);
  });

  it('refuses nothing when the ceiling could not be asked - the server decides', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'take_picked_file' ? new ArrayBuffer(1) : undefined
    );
    const big = { path: '/c/0_big.pdf', name: 'big.pdf', mime: 'application/pdf', size: 500 * MB };
    const result = await stageSharedFiles([big], 'g', null, async () => {});
    expect(result).toEqual({ staged: 1, lost: 0, tooLarge: [] });
  });

  it('stages every file in the conversation chosen, even when another opens mid-batch', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'take_picked_file' ? new ArrayBuffer(1) : undefined
    );
    // The member opens another conversation while the first file is being prepared.
    let onScreen = 'chosen';
    const stagedIn: string[] = [];
    const entry = (n: string) => ({ path: `/c/${n}`, name: n, mime: 'video/mp4', size: 1 });
    await stageSharedFiles(
      [entry('a'), entry('b'), entry('c')],
      onScreen,
      limits,
      async (_f, to) => {
        stagedIn.push(to);
        onScreen = 'elsewhere';
      }
    );
    expect(onScreen).toBe('elsewhere');
    expect(stagedIn).toEqual(['chosen', 'chosen', 'chosen']);
  });

  it('stops at a sign-out: the rest is deleted unread, never staged into the ended session', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'take_picked_file' ? new ArrayBuffer(1) : undefined
    );
    let signedIn = true;
    const staged: string[] = [];
    const entry = (n: string) => ({ path: `/c/${n}`, name: n, mime: 'image/png', size: 1 });
    const result = await stageSharedFiles(
      [entry('a'), entry('b'), entry('c')],
      'g',
      limits,
      async (file) => {
        // Staged only because the sign-out comes after it: one DURING its preparation is refused by
        // `handleFilesSelected`'s own `stillWanted` (useMessaging.mediaEnqueue).
        staged.push(file.name);
        signedIn = false;
      },
      () => signedIn
    );
    expect(staged).toEqual(['a']);
    expect(result).toEqual({ staged: 1, lost: 0, tooLarge: [] });
    const calls = invoke.mock.calls.filter(([cmd]) => cmd !== 'plugin:log|log');
    expect(calls).toContainEqual(['discard_picked_file', { path: '/c/b' }]);
    expect(calls).toContainEqual(['discard_picked_file', { path: '/c/c' }]);
    expect(calls).not.toContainEqual(['take_picked_file', { path: '/c/b' }]);
  });
});
