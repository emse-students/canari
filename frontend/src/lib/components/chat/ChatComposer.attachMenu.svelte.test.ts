/**
 * ONE ATTACHMENT MENU, AND EACH ENTRY GOES STRAIGHT TO ITS PICKER (user, 2026-10-02, iPhone: *"deux
 * menus similaires, n'en faire qu'un"*, and *"le menu ne se ferme pas"*).
 *
 * The second menu was WebKit's: an `<input type="file">` accepting images with no `capture` opens
 * iOS's own Phototheque / Prendre une photo / Choisir les fichiers sheet, whatever the page wanted.
 * So in the iOS app the library and files entries open NATIVE pickers, the camera entry an input
 * WITH `capture`; in an iOS browser Canari draws no menu and the system sheet is the one menu.
 * Android keeps inputs, each accepting exactly what makes it open one picker (`attachSources.ts`).
 *
 * And the menu closes: on a pick, a tap outside, Escape, Back, and when the keyboard opens - the
 * last two through `composerSurface.ts`, whose own table is `composerSurface.test.ts`.
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import ChatComposer from './ChatComposer.svelte';
import type { AttachRuntime } from '$lib/utils/chat/attachSources';
import { clearHistoryOverlayStack, initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';

// The "+" is the PHONE APPS' composer (`usesGlassChrome`); a phone's browser keeps the paperclip.
const env = vi.hoisted(() => ({ app: true, runtime: 'android-app' as AttachRuntime }));
vi.mock('$lib/mobile/glassChrome', () => ({ usesGlassChrome: () => env.app }));
vi.mock('$lib/utils/chat/attachSources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/attachSources')>()),
  currentAttachRuntime: () => env.runtime,
}));
const native = vi.hoisted(() => ({ pick: vi.fn(async (_kind: string) => [] as File[]) }));
vi.mock('$lib/utils/chat/nativeAttachPicker', () => ({ pickNatively: native.pick }));
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

// The menu fades; happy-dom rejects a cancelled animation, see the helper.
afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
const originalMatchMedia = window.matchMedia;

afterEach(() => {
  env.app = true;
  env.runtime = 'android-app';
  native.pick.mockClear();
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
function mountComposer(extra: Record<string, unknown> = {}) {
  const props = $state({
    messageText: '',
    onMessageChange: () => {},
    onSend: () => {},
    onFilesSelected: vi.fn(),
    ...extra,
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ChatComposer, { target, props });
  mounted.push(() => void unmount(app));
  flushSync();
  return props;
}

/** Records which file input was opened: what it accepts, and whether it captures. */
function spyOnPickers(): string[] {
  const opened: string[] = [];
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
    this: HTMLInputElement
  ) {
    opened.push(this.accept + (this.hasAttribute('capture') ? ' +capture' : ''));
  });
  return opened;
}

function plus(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>('button[aria-label="Ajouter"]');
  if (!el) throw new Error('"+" button not found');
  return el;
}

function entries(): string[] {
  return [...document.querySelectorAll('[role="menuitem"]')].map(
    (i) => i.textContent?.trim() ?? ''
  );
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (b) => b.textContent?.trim() === label
  );
  if (!item) throw new Error(`menu item ${label} not found`);
  return item;
}

function openMenu() {
  plus().click();
  flushSync();
}

describe('the one attachment menu - Android app', () => {
  it('is ONE "+" opening a menu, never a picker by itself', () => {
    stubMatchMedia(true);
    mountComposer();
    const opened = spyOnPickers();

    expect(document.querySelector('.chat-composer-chevron')).toBeNull();
    openMenu();

    expect(opened).toEqual([]);
    expect(entries()).toEqual([
      'Photothèque',
      'Prendre une photo',
      'Filmer une vidéo',
      'Tous les fichiers',
    ]);
    expect(plus().getAttribute('aria-expanded')).toBe('true');
  });

  // A fresh composer per entry: reopening a menu inside its own 180 ms outro is a test artefact
  // that happy-dom reports as an unhandled animation rejection.
  it.each([
    ['Photothèque', 'image/*,video/*'],
    ['Prendre une photo', 'image/* +capture'],
    ['Filmer une vidéo', 'video/* +capture'],
    ['Tous les fichiers', 'image/*,video/*,audio/*,application/pdf,.doc,.docx,.zip'],
  ])('"%s" opens the input that reaches its picker (%s), and closes', (label, accept) => {
    stubMatchMedia(true);
    mountComposer();
    const opened = spyOnPickers();

    openMenu();
    menuItem(label).click();
    flushSync();

    expect(opened).toEqual([accept]);
    expect(plus().getAttribute('aria-expanded')).toBe('false');
  });

  it('hands what an input picked to the upload path', () => {
    stubMatchMedia(true);
    const props = mountComposer();
    const library = document.querySelector<HTMLInputElement>(
      'input[data-attach-source="library"]'
    )!;
    const photo = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(library, 'files', { value: [photo], configurable: true });

    library.dispatchEvent(new Event('change', { bubbles: true }));

    expect(props.onFilesSelected).toHaveBeenCalledWith([photo]);
  });
});

describe('the one attachment menu - iOS app', () => {
  it('opens the library and files NATIVELY - no file input, so no WebKit sheet', async () => {
    stubMatchMedia(true);
    env.runtime = 'ios-app';
    const picked = new File(['x'], 'IMG_0001.heic', { type: 'image/heic' });
    native.pick.mockResolvedValueOnce([picked]);
    const props = mountComposer();
    const opened = spyOnPickers();

    openMenu();
    expect(entries()).toEqual(['Photothèque', 'Appareil photo', 'Tous les fichiers']);
    menuItem('Photothèque').click();
    flushSync();
    await tick();
    await Promise.resolve();

    expect(opened).toEqual([]);
    expect(native.pick).toHaveBeenCalledWith('library');
    expect(props.onFilesSelected).toHaveBeenCalledWith([picked]);
  });

  it('opens "Tous les fichiers" natively too', () => {
    stubMatchMedia(true);
    env.runtime = 'ios-app';
    mountComposer();
    const opened = spyOnPickers();

    openMenu();
    menuItem('Tous les fichiers').click();

    expect(opened).toEqual([]);
    expect(native.pick).toHaveBeenCalledWith('files');
  });

  it('opens the camera through an input WITH capture - WebKit then shows the camera, not its sheet', () => {
    stubMatchMedia(true);
    env.runtime = 'ios-app';
    mountComposer();
    const opened = spyOnPickers();

    openMenu();
    menuItem('Appareil photo').click();

    expect(opened).toEqual(['image/*,video/* +capture']);
    expect(native.pick).not.toHaveBeenCalled();
  });
});

describe('the one attachment menu - the website', () => {
  it('on an iOS phone browser draws NO menu: its paperclip IS the input, and the system sheet the menu', () => {
    stubMatchMedia(true);
    env.app = false;
    env.runtime = 'ios-web';
    mountComposer();

    expect(document.querySelector('button[aria-label="Joindre un fichier"]')).toBeNull();
    const input = document.querySelector<HTMLInputElement>(
      'label input[type="file"][aria-label="Joindre un fichier"]'
    );
    expect(input?.accept).toBe('image/*,video/*,audio/*,application/pdf,.doc,.docx,.zip');
    expect(input?.hasAttribute('capture')).toBe(false);
  });

  it("on an Android phone browser, the paperclip opens Canari's menu", () => {
    stubMatchMedia(true);
    env.app = false;
    env.runtime = 'android-web';
    mountComposer();

    document.querySelector<HTMLButtonElement>('button[aria-label="Joindre un fichier"]')!.click();
    flushSync();
    expect(entries()).toContain('Photothèque');
  });

  it('on a desktop, opens the file dialog directly, with no menu', () => {
    stubMatchMedia(false);
    env.app = false;
    env.runtime = 'desktop';
    mountComposer();
    const opened = spyOnPickers();

    document.querySelector<HTMLButtonElement>('button[aria-label="Joindre un fichier"]')!.click();
    flushSync();

    expect(opened).toEqual(['image/*,video/*,audio/*,application/pdf,.doc,.docx,.zip']);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('the menu closes', () => {
  it('on a tap outside', () => {
    stubMatchMedia(true);
    mountComposer();
    openMenu();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    flushSync();
    expect(plus().getAttribute('aria-expanded')).toBe('false');
  });

  it('on Escape, wherever focus is', () => {
    stubMatchMedia(true);
    mountComposer();
    openMenu();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    flushSync();
    expect(plus().getAttribute('aria-expanded')).toBe('false');
  });

  it('on Back: the open menu holds a history entry, and popping it closes the menu', () => {
    stubMatchMedia(true);
    clearHistoryOverlayStack();
    const stopHistory = initHistoryOverlayStack();
    mounted.push(stopHistory);
    mountComposer();
    const push = vi.spyOn(history, 'pushState');
    openMenu();
    expect(push).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new PopStateEvent('popstate', { state: { canariOverlay: 1 } }));
    flushSync();
    expect(plus().getAttribute('aria-expanded')).toBe('false');
  });

  it('when the text field takes focus (the keyboard is coming)', () => {
    stubMatchMedia(true);
    mountComposer();
    openMenu();
    document
      .querySelector<HTMLElement>('[contenteditable="true"]')!
      .dispatchEvent(new FocusEvent('focus'));
    flushSync();
    expect(plus().getAttribute('aria-expanded')).toBe('false');
  });
});
