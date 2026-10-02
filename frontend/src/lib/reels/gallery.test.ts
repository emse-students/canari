/**
 * The staged save: the video crosses the IPC in offset-tagged base64 chunks that reassemble to the
 * same bytes, the platform's answer is an outcome, and a failure before the import discards the
 * staged copy. `invoke` is a stand-in that plays the Rust side.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/appVersion')>()),
  isMobileTauriRuntime: () => true,
}));

const { GALLERY_CHUNK_BYTES, GalleryError, saveVideoToGallery } = await import('./gallery');

afterEach(() => invoke.mockReset());

/**
 * Plays the Rust side: stages chunks, then answers the import with `status`. The chunks are kept as
 * decoded buffers (Node's `Buffer`), and the test compares them with `Buffer.equals`. A per-byte
 * array and `toEqual` over 1.5 MB took longer than the test timeout on a loaded machine
 * (2026-10-02).
 */
function rust(status: string) {
  const staged: Buffer[] = [];
  let size = 0;
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'plugin:gallery|append_video_chunk') {
      expect(args.offset).toBe(size);
      const chunk = Buffer.from(args.data as string, 'base64');
      staged.push(chunk);
      size += chunk.length;
      return size;
    }
    if (cmd === 'plugin:gallery|save_video') return { status };
    return undefined;
  });
  return { bytes: () => Buffer.concat(staged) };
}

describe('saveVideoToGallery', () => {
  it('stages the video in order and the chunks reassemble to the same bytes', async () => {
    const bytes = Uint8Array.from({ length: GALLERY_CHUNK_BYTES * 2 + 5 }, (_, i) => i % 251);
    const staged = rust('saved');
    expect(await saveVideoToGallery(new Blob([bytes]), 'r.mp4')).toBe('saved');
    expect(staged.bytes().equals(Buffer.from(bytes))).toBe(true);
    const chunks = invoke.mock.calls.filter(([c]) => c === 'plugin:gallery|append_video_chunk');
    expect(chunks).toHaveLength(3);
    const save = invoke.mock.calls.find(([c]) => c === 'plugin:gallery|save_video')!;
    expect(save[1]).toEqual({ session: chunks[0][1].session, name: 'r.mp4' });
  });

  it('a refusal is an outcome, not a failure', async () => {
    rust('denied');
    expect(await saveVideoToGallery(new Blob([new Uint8Array([1])]), 'r.mp4')).toBe('denied');
  });

  it('a failed chunk discards the staged copy and throws a typed error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'plugin:gallery|append_video_chunk') throw new Error('disk full');
      return undefined;
    });
    await expect(
      saveVideoToGallery(new Blob([new Uint8Array([1])]), 'r.mp4')
    ).rejects.toBeInstanceOf(GalleryError);
    expect(invoke.mock.calls.map(([c]) => c)).toContain('plugin:gallery|discard_video');
  });
});
