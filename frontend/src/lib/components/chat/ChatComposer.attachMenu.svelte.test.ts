/**
 * ON A PHONE, ONE "+" GROWS INTO THE COMPOSER'S ACTIONS (user, 2026-09-30), and its first two are
 * PHOTOS OR EVERY FILE (user, 2026-09-28).
 *
 * One input accepting images, videos, audio, PDFs and archives at once is a DOCUMENT request, and
 * Android answers it with the file browser - never with the photo grid people expect from
 * Messenger. So the phone's "+" offers a media-only input (the system's photo picker, no gallery
 * permission) and the all-files one - and replaces the paperclip, the poll and GIF buttons and the
 * chevron that folded them. A desktop keeps its single file dialog and its fold.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatComposer from './ChatComposer.svelte';

// The "+" is the PHONE APPS' composer (`usesGlassChrome`); a phone's browser keeps the paperclip.
const chrome = vi.hoisted(() => ({ app: true }));
vi.mock('$lib/mobile/glassChrome', () => ({ usesGlassChrome: () => chrome.app }));
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The menu fades; happy-dom rejects a cancelled animation, see the helper.
afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
const originalMatchMedia = window.matchMedia;

afterEach(() => {
  chrome.app = true;
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

function plus(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>('button[aria-label="Ajouter"]');
  if (!el) throw new Error('"+" button not found');
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
  it('on a phone, is ONE "+" - no paperclip, no chevron - and it opens a menu, not a picker', () => {
    stubMatchMedia(true);
    mountComposer();
    const opened = spyOnPickers();

    expect(document.querySelector('button[aria-label="Joindre un fichier"]')).toBeNull();
    expect(document.querySelector('.chat-composer-chevron')).toBeNull();
    plus().click();
    flushSync();

    expect(opened).toEqual([]);
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    expect(plus().getAttribute('aria-expanded')).toBe('true');
  });

  it('"Photos et vidéos" opens a media-only input, which is what reaches the photo grid', () => {
    stubMatchMedia(true);
    mountComposer();
    const opened = spyOnPickers();

    plus().click();
    flushSync();
    menuItem('Photos et vidéos').click();
    flushSync();

    expect(opened).toEqual(['image/*,video/*']);
    // The menu closes with the pick (its node may linger for the transition out).
    expect(plus().getAttribute('aria-expanded')).toBe('false');
  });

  it('"Tous les fichiers" opens the input that accepts every supported file', () => {
    stubMatchMedia(true);
    mountComposer();
    const opened = spyOnPickers();

    plus().click();
    flushSync();
    menuItem('Tous les fichiers').click();
    flushSync();

    expect(opened).toEqual(['image/*,video/*,audio/*,application/pdf,.doc,.docx,.zip']);
  });

  it("in a phone's BROWSER, keeps the website's paperclip - photos or every file - and its fold", () => {
    stubMatchMedia(true);
    chrome.app = false;
    mountComposer();
    const opened = spyOnPickers();

    expect(document.querySelector('button[aria-label="Ajouter"]')).toBeNull();
    paperclip().click();
    flushSync();
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim())
    ).toEqual(['Photos et vidéos', 'Tous les fichiers']);
    menuItem('Photos et vidéos').click();
    flushSync();
    expect(opened).toEqual(['image/*,video/*']);
    // No glass on the website.
    expect(paperclip().classList.contains('glass-chrome')).toBe(false);
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
