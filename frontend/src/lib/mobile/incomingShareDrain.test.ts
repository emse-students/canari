const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { drainNativeShare, parseSharedManifest, readSharedFiles } from './incomingShareDrain';
import { incomingShare } from '$lib/stores/incomingShare.svelte';

/**
 * The native share manifest is written by another layer (`IncomingShare.kt`) and read here: a
 * malformed one must be dropped rather than half-offered, and every item that does not reach the
 * composer must be COUNTED, because the member was shown nothing else that would say so.
 */
describe('parseSharedManifest', () => {
  it('reads text, files and the refused count', () => {
    const parsed = parseSharedManifest(
      JSON.stringify({
        id: 'x',
        text: 'hi',
        files: [{ path: '/c/0_a.png', name: 'a.png', mime: 'image/png' }],
        refused: 2,
      })
    );
    expect(parsed).toEqual({
      text: 'hi',
      files: [{ path: '/c/0_a.png', name: 'a.png', mime: 'image/png' }],
      refused: 2,
    });
  });

  it('keeps only well-formed file entries', () => {
    const parsed = parseSharedManifest(
      JSON.stringify({
        files: [{ path: '/c/a' }, null, 'x', { path: '/c/b', name: 'b', mime: 'text/plain' }],
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
        return JSON.stringify({
          text: 'look',
          files: [{ path: '/c/0_a.png', name: 'a.png', mime: 'image/png' }],
          refused: 1,
        });
      }
      return undefined;
    });
    expect(await drainNativeShare()).toEqual({ lost: 1 });
    expect(incomingShare.pending).toEqual({
      text: 'look',
      files: [{ path: '/c/0_a.png', name: 'a.png', mime: 'image/png' }],
    });
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'take_picked_file')).toEqual([]);
  });

  it('counts a corrupt manifest as one lost share', async () => {
    invoke.mockResolvedValueOnce('{not json');
    expect(await drainNativeShare()).toEqual({ lost: 1 });
    expect(incomingShare.pending).toBeNull();
  });
});

describe('readSharedFiles', () => {
  beforeEach(() => invoke.mockReset());

  it('reads each copy through take_picked_file and counts the ones lost', async () => {
    // Only `take_picked_file` is answered: the logger reaches `invoke` too, and refusing its
    // command would fail the test on a rejection nothing under test owns.
    invoke.mockImplementation(async (cmd: string, args?: { path: string }) => {
      if (cmd !== 'take_picked_file') return undefined;
      if (args?.path === '/c/0_a.png') return new ArrayBuffer(3);
      throw new Error('path outside the picker directories');
    });
    const { files, lost } = await readSharedFiles([
      { path: '/c/0_a.png', name: 'a.png', mime: 'image/png' },
      { path: '/c/1_b.pdf', name: 'b.pdf', mime: 'application/pdf' },
    ]);
    expect(lost).toBe(1);
    expect(files.map((f) => [f.name, f.type, f.size])).toEqual([['a.png', 'image/png', 3]]);
  });
});
