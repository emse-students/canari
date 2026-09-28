/**
 * ON A PHONE, THE PAPERCLIP OFFERS PHOTOS OR EVERY FILE (user, 2026-09-28).
 *
 * One input accepting images, videos, audio, PDFs and archives at once is a DOCUMENT request, and
 * Android answers it with the file browser - never with the photo grid people expect from
 * Messenger. So a phone gets a menu: a media-only input (the system's photo picker, no gallery
 * permission) and the all-files one. A desktop keeps its single file dialog.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatComposer from './ChatComposer.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The menu fades; happy-dom rejects a cancelled animation, see the helper.
afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
const originalMatchMedia = window.matchMedia;

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

/** Minimal `MediaQueryList` double - `isNarrowChatLayout()` reads only `.matches`. */
function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

/** Mounts an EMPTY composer: typed text folds the attach button away. */
function mountComposer() {
  const props = $state({
    messageText: '',
    onMessageChange: () => {},
    onSend: () => {},
    onFilesSelected: vi.fn(),
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ChatComposer, { target, props });
  mounted.push(() => void unmount(app));
  flushSync();
  return props;
}

/** Records which file input was opened, by what it accepts. */
function spyOnPickers(): string[] {
  const opened: string[] = [];
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
    this: HTMLInputElement
  ) {
    opened.push(this.accept);
  });
  return opened;
}

function paperclip(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>('button[aria-label="Joindre un fichier"]');
  if (!el) throw new Error('attach button not found');
  return el;
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (b) => b.textContent?.trim() === label
  );
  if (!item) throw new Error(`menu item ${label} not found`);
  return item;
}

describe('the attach button', () => {
  it('on a phone, opens a menu and not a picker', () => {
    stubMatchMedia(true);
    mountComposer();
    const opened = spyOnPickers();

    paperclip().click();
    flushSync();

    expect(opened).toEqual([]);
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    expect(paperclip().getAttribute('aria-expanded')).toBe('true');
  });

  it('"Photos et vidéos" opens a media-only input, which is what reaches the photo grid', () => {
    stubMatchMedia(true);
    mountComposer();
    const opened = spyOnPickers();

    paperclip().click();
    flushSync();
    menuItem('Photos et vidéos').click();
    flushSync();

    expect(opened).toEqual(['image/*,video/*']);
    // The menu closes with the pick (its node may linger for the fade-out).
    expect(paperclip().getAttribute('aria-expanded')).toBe('false');
  });

  it('"Tous les fichiers" opens the input that accepts every supported file', () => {
    stubMatchMedia(true);
    mountComposer();
    const opened = spyOnPickers();

    paperclip().click();
    flushSync();
    menuItem('Tous les fichiers').click();
    flushSync();

    expect(opened).toEqual(['image/*,video/*,audio/*,application/pdf,.doc,.docx,.zip']);
  });

  it('on a desktop, opens the file dialog directly, with no menu', () => {
    stubMatchMedia(false);
    mountComposer();
    const opened = spyOnPickers();

    paperclip().click();
    flushSync();

    expect(opened).toEqual(['image/*,video/*,audio/*,application/pdf,.doc,.docx,.zip']);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('hands files from the media input to the same upload path', () => {
    stubMatchMedia(true);
    const props = mountComposer();
    const media = document.querySelector<HTMLInputElement>('input[accept="image/*,video/*"]')!;
    const photo = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(media, 'files', { value: [photo], configurable: true });

    media.dispatchEvent(new Event('change', { bubbles: true }));

    expect(props.onFilesSelected).toHaveBeenCalledWith([photo]);
  });
});
