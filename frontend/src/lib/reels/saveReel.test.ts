/**
 * Saving a reel: the decrypted video goes to the phone's gallery on a phone build and to the
 * download elsewhere, the cache hold is always given back, and the outcome is typed.
 */
import { describe, expect, it, vi } from 'vitest';
import { reelFileName, saveReel, type SaveReelDeps } from './saveReel';
import type { SaveableReel } from '$lib/reels/saveReel';

vi.mock('$lib/utils/apiUrl', () => ({ mediaUrl: () => 'https://media.test' }));

const video = {
  type: 'video' as const,
  mediaId: 'm-1',
  key: 'k',
  iv: 'i',
  mimeType: 'video/mp4',
  size: 3,
};
const reel: SaveableReel = {
  id: '0123456789abcdef',
  createdAt: '2026-10-01T09:00:00Z',
  media: [video],
};

function deps(native: boolean): SaveReelDeps {
  return {
    acquire: vi.fn(async () => 'blob:reel'),
    release: vi.fn(),
    readBlob: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' })),
    hasNativeGallery: () => native,
    saveToGallery: vi.fn(async () => 'saved' as const),
    saveBlobAs: vi.fn(async () => true),
  };
}

describe('saveReel', () => {
  it('gives a phone build the video for its gallery, under the reel name', async () => {
    const d = deps(true);
    expect(await saveReel(reel, d)).toBe('saved');
    expect(d.acquire).toHaveBeenCalledWith(video, 'https://media.test');
    const [given, name] = vi.mocked(d.saveToGallery).mock.calls[0];
    expect(new Uint8Array(await given.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(name).toBe('canari-reel-2026-10-01-01234567.mp4');
    expect(d.release).toHaveBeenCalledWith(video);
  });

  it('downloads it everywhere else', async () => {
    const d = deps(false);
    expect(await saveReel(reel, d)).toBe('downloaded');
    expect(d.saveToGallery).not.toHaveBeenCalled();
  });

  it('passes on a refusal, and gives the hold back when the save throws', async () => {
    const refused = deps(true);
    vi.mocked(refused.saveToGallery).mockResolvedValueOnce('denied');
    expect(await saveReel(reel, refused)).toBe('denied');

    const failing = deps(true);
    vi.mocked(failing.saveToGallery).mockRejectedValueOnce(new Error('disk'));
    await expect(saveReel(reel, failing)).rejects.toThrow('disk');
    expect(failing.release).toHaveBeenCalledTimes(1);
  });
});

describe('reelFileName', () => {
  it('names the day and a short id', () => {
    expect(reelFileName(reel)).toBe('canari-reel-2026-10-01-01234567.mp4');
  });
});
