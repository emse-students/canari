import { describe, expect, it, vi } from 'vitest';
import { MediaService } from '$lib/media';
import { RequestBodyTooLargeError } from '$lib/utils/mediaRequestLimits';

describe('MediaService.uploadRaw', () => {
  it('refuses an image over the 8 MiB request budget without sending anything', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const file = new File([new Uint8Array(9 * 1024 * 1024)], 'big.jpg', { type: 'image/jpeg' });
    await expect(new MediaService().uploadRaw(file, 'tok')).rejects.toBeInstanceOf(
      RequestBodyTooLargeError
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
