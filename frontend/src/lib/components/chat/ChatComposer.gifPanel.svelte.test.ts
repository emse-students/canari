/**
 * THE GIF PANEL TAKES THE KEYBOARD'S PLACE (user, 2026-10-02: *"un panneau de la taille du clavier
 * qui s'ouvre a sa place"*), and its tiles hold their size before they load.
 *
 * What a component test can see: the panel is the last thing in the composer's footer and as tall as
 * the keyboard last measured; every tile's box comes from the size the provider DECLARED; a tap sends
 * the GIF with that size and closes the panel; Back closes it; tapping the text field hands its room
 * to the keyboard. What it cannot see - the composer standing still while a real keyboard animates -
 * is `panelSpacerPx`'s arithmetic (`composerSurface.test.ts`) and a reading on the phones.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ChatComposer from './ChatComposer.svelte';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';
import {
  rememberKeyboardHeight,
  resetKeyboardHeightMemoryForTests,
} from '$lib/stores/keyboardHeightMemory';
import { clearHistoryOverlayStack, initHistoryOverlayStack } from '$lib/utils/historyOverlayStack';

vi.mock('$lib/mobile/glassChrome', () => ({ usesGlassChrome: () => true }));
vi.mock('$lib/utils/chat/attachSources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/chat/attachSources')>()),
  currentAttachRuntime: () => 'android-app',
}));
const gifs = vi.hoisted(() => ({
  page: vi.fn(async () => ({
    gifs: [
      {
        id: 'wide',
        preview: { url: 'https://g/wide-s.gif', width: 200, height: 100 },
        full: { url: 'https://g/wide-m.gif', width: 498, height: 249 },
      },
      {
        id: 'tall',
        preview: { url: 'https://g/tall-s.gif', width: 100, height: 200 },
        full: { url: 'https://g/tall-m.gif', width: 240, height: 480 },
      },
    ],
    hasNext: false,
  })),
}));
vi.mock('$lib/utils/chat/gifSearch', () => ({ KLIPY_KEY: 'test', fetchGifPage: gifs.page }));

afterAll(adoptTransitionAnimations());

const mounted: (() => void)[] = [];
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  resetKeyboardHeightMemoryForTests();
  clearHistoryOverlayStack();
  mounted.push(initHistoryOverlayStack());
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  // happy-dom lays nothing out: give the grid's scroller a phone's box.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(206);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  window.matchMedia = originalMatchMedia;
  vi.restoreAllMocks();
});

function mountComposer() {
  const props = $state({
    messageText: '',
    onMessageChange: () => {},
    onSend: () => {},
    onSendGif: vi.fn(),
  });
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(ChatComposer, { target, props });
  mounted.push(() => void unmount(app));
  flushSync();
  return props;
}

function openGifPanel() {
  document.querySelector<HTMLButtonElement>('button[aria-label="Ajouter"]')!.click();
  flushSync();
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((b) => b.textContent?.trim() === 'Envoyer un GIF')!
    .click();
  flushSync();
}

const panel = () => document.querySelector<HTMLElement>('[data-testid="composer-gif-panel"]');
const tiles = () => [
  ...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Envoyer ce GIF"]'),
];

describe('the GIF panel', () => {
  it('opens in the keyboard place, as tall as the keyboard last measured, under the composer', () => {
    rememberKeyboardHeight(312);
    mountComposer();
    openGifPanel();

    const footer = document.querySelector('footer.chat-composer-footer')!;
    expect(panel()).not.toBeNull();
    expect(panel()!.style.height).toBe('312px');
    expect(footer.lastElementChild).toBe(panel());
    expect(footer.classList.contains('has-keyboard-panel')).toBe(true);
  });

  it('reserves every tile from the declared size, before any GIF has loaded', async () => {
    mountComposer();
    openGifPanel();
    await vi.waitFor(() => expect(tiles()).toHaveLength(2));
    flushSync();

    // Two columns of 100 px in 206 px with a 6 px gap: a 2:1 GIF is 50 tall, a 1:2 one 200.
    const [wide, tall] = tiles();
    expect([wide.style.width, wide.style.height]).toEqual(['100px', '50px']);
    expect([tall.style.width, tall.style.height]).toEqual(['100px', '200px']);
  });

  it('sends a tapped GIF with the size of the rendition sent, and closes', async () => {
    const props = mountComposer();
    openGifPanel();
    await vi.waitFor(() => expect(tiles()).toHaveLength(2));
    tiles()[1].click();
    flushSync();

    expect(props.onSendGif).toHaveBeenCalledWith('https://g/tall-m.gif', {
      width: 240,
      height: 480,
    });
    expect(panel()).toBeNull();
  });

  it('closes on Back', () => {
    mountComposer();
    openGifPanel();
    window.dispatchEvent(new PopStateEvent('popstate', { state: { canariOverlay: 1 } }));
    flushSync();
    expect(panel()).toBeNull();
  });

  it('hands its room to the keyboard when the text field is tapped: still reserved, no longer live', () => {
    mountComposer();
    openGifPanel();
    const editor = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
    editor.dispatchEvent(new FocusEvent('focus'));
    flushSync();

    // No keyboard rises in happy-dom: the room is held, the grid inert...
    expect(panel()).not.toBeNull();
    expect(panel()!.querySelector('[inert]')).not.toBeNull();
    // ...and a blur with no keyboard (a hardware keyboard) gives it back.
    editor.dispatchEvent(new FocusEvent('blur'));
    flushSync();
    expect(panel()).toBeNull();
  });
});
