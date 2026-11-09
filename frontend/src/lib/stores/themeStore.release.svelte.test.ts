// @vitest-environment happy-dom
import { flushSync } from 'svelte';
import { themeStore } from './themeStore.svelte';

/**
 * THE NATIVE BARS GO BACK TO THE THEME THE PAGE SHOWS, EVEN WHEN IT CHANGED IN THE RELEASE'S FLUSH.
 *
 * `holdNativeBar`'s release runs from `CameraScreen`'s effect teardown, where Svelte hands a `$state`
 * read the value from before the flush. It read `isDark` there, so a theme switched in the same flush
 * as the camera closing handed the bars the OLD theme (frontend/architecture, "A teardown sees the
 * values its effect saw"). It now reads the theme the document carries.
 */
beforeEach(() => {
  localStorage.clear();
  (window as any).matchMedia = vi.fn((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

it('releases the bars to a theme switched in the same flush as the teardown that releases them', () => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  const set = vi.fn();
  (window as any).canariTheme = { set };
  themeStore.setPreference('light');

  let cameraOpen = $state(true);
  const stop = $effect.root(() => {
    $effect(() => {
      if (!cameraOpen) return;
      const release = themeStore.holdNativeBar('dark');
      return () => release();
    });
  });
  try {
    flushSync();
    set.mockClear();

    themeStore.setPreference('dark');
    cameraOpen = false;
    flushSync();

    expect(set.mock.calls.at(-1)).toEqual(['dark']);
  } finally {
    stop();
    delete (window as any).canariTheme;
  }
});
