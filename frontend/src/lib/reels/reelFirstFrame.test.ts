/**
 * A PICTURE IS PUBLISHED WITH ITS THUMBHASH, AS A VIDEO IS WITH ITS FIRST FRAME'S (owner,
 * 2026-11-11: a CanaReels photo page was black until its file came, photos carried none). The one
 * helper every publisher calls (`preparedMediaPlaceholder`) makes it for a picture, and makes none
 * for a file that is neither.
 */
import { vi } from 'vitest';

const fromImage = vi.fn(async (file: File) => `hash-of-${file.name}`);
vi.mock('$lib/utils/mediaPlaceholder', () => ({
  placeholderForImageFile: (file: File) => fromImage(file),
}));

const { preparedMediaPlaceholder } = await import('./reelFirstFrame');

it('a picture is published with its own ThumbHash', async () => {
  const file = new File([new Uint8Array(4)], 'photo.webp', { type: 'image/webp' });
  await expect(preparedMediaPlaceholder(file)).resolves.toBe('hash-of-photo.webp');
});

it('a file that is neither a picture nor a video gets none, and nothing is decoded', async () => {
  fromImage.mockClear();
  const file = new File([new Uint8Array(4)], 'notes.pdf', { type: 'application/pdf' });
  await expect(preparedMediaPlaceholder(file)).resolves.toBeNull();
  expect(fromImage).not.toHaveBeenCalled();
});

it('a picture this engine cannot decode is published without one, never refused', async () => {
  fromImage.mockResolvedValueOnce(null as unknown as string);
  const file = new File([new Uint8Array(4)], 'photo.heic', { type: 'image/heic' });
  await expect(preparedMediaPlaceholder(file)).resolves.toBeNull();
});
