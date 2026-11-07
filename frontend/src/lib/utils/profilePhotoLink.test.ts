// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

const isTauri = vi.fn(() => false);
vi.mock('$lib/utils/tauriRuntime', () => ({ isTauriRuntime: () => isTauri() }));
vi.mock('$lib/utils/Log', () => ({ Log: { d: vi.fn(), i: vi.fn() } }));

const { MIGALLERY_PROFILE_PHOTO_URL, openProfilePhotoPage } = await import('./profilePhotoLink');
const { Log } = await import('$lib/utils/Log');

describe('openProfilePhotoPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names MiGallery\'s "mes photos" page', () => {
    expect(MIGALLERY_PROFILE_PHOTO_URL).toBe('https://gallery.mitv.fr/mes-photos');
  });

  it('opens a NEW TAB on the web, synchronously, leaving the Canari tab where it is', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    openProfilePhotoPage();
    expect(open).toHaveBeenCalledWith(MIGALLERY_PROFILE_PHOTO_URL, '_blank', 'noopener');
  });

  it('logs a null answer from window.open', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    openProfilePhotoPage();
    expect(Log.d).toHaveBeenCalledWith('profilePhoto', expect.stringContaining('null'));
  });
});
