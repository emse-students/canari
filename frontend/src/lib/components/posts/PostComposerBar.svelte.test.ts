// @vitest-environment happy-dom
/**
 * THE COMPOSER BAR - which chooser each attachment asks the OS for, and that a pick only ADDS.
 *
 * The accept list is the whole fix for the photo button that opened Android's generic file
 * browser: one input accepting images, video, audio, PDF and Office together cannot be answered
 * with a photo picker. So the property pinned here is the attribute each input carries - the OS
 * reads nothing else - and that NO input carries `capture` (D-camera, 2026-10-11: the camera chip opens
 * Canari's own camera overlay, whose takes come back through `onFiles`).
 *
 * The reset is pinned because the callers APPEND: an input that kept its selection would hand the
 * previous pick over again on the next change, and the composer would show every photo twice.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import PostComposerBar from './PostComposerBar.svelte';
import { m } from '$lib/paraglide/messages';

// The camera chip mounts the real capture screen: no server for its cap, no lens to open. Both are
// answered here, or every run prints a refused connection and a missing `getUserMedia`.
vi.mock('$lib/posts/api', () => ({
  getReelLimits: () =>
    Promise.resolve({
      maxDurationMs: 90_000,
      chatMaxDurationMs: 60_000,
      retentionDays: 30,
      warningWindowDays: 7,
    }),
}));
vi.mock('$lib/reels/cameraAccess', async (orig) => ({
  ...(await orig<typeof import('$lib/reels/cameraAccess')>()),
  postCameraOpener: () => () => new Promise<MediaStream>(() => {}),
}));

const runtime = vi.hoisted(() => ({ iosApp: false }));
vi.mock('$lib/utils/appVersion', async (orig) => ({
  ...(await orig<typeof import('$lib/utils/appVersion')>()),
  isIosTauriRuntime: () => runtime.iosApp,
}));
const pickNatively = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils/chat/nativeAttachPicker', () => ({ pickNatively }));

const mounted: (() => void)[] = [];

afterEach(() => {
  runtime.iosApp = false;
  pickNatively.mockReset();
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

const action = createRawSnippet(() => ({
  render: () => '<button data-testid="publish">P</button>',
}));

function mountBar(overrides: Record<string, unknown> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = {
    onFiles: vi.fn(),
    onFormat: vi.fn(),
    pollActive: false,
    onTogglePoll: vi.fn(),
    formActive: false,
    onToggleForm: vi.fn(),
    action,
    ...overrides,
  };
  const component = mount(PostComposerBar, { target, props });
  mounted.push(() => unmount(component));
  flushSync();
  return { target, props };
}

function fileInputs(target: HTMLElement) {
  return Array.from(target.querySelectorAll<HTMLInputElement>('input[type="file"]'));
}

it('asks photos and documents from two separate choosers, and none captures', () => {
  const { target } = mountBar();
  const inputs = fileInputs(target).map((i) => ({
    accept: i.getAttribute('accept'),
    capture: i.getAttribute('capture'),
  }));

  expect(inputs).toEqual([
    { accept: 'image/*,video/*', capture: null },
    {
      accept: 'audio/*,.pdf,.doc,.docx,.odt,.xls,.xlsx,.ods,.ppt,.pptx,.odp,.txt,.rtf,.zip,.epub',
      capture: null,
    },
  ]);
});

it('hands over only what was just picked, and empties the input for the next pick', () => {
  const { target, props } = mountBar();
  const gallery = fileInputs(target)[0];
  const photo = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
  Object.defineProperty(gallery, 'files', { value: [photo], configurable: true });
  let cleared = false;
  Object.defineProperty(gallery, 'value', {
    configurable: true,
    get: () => '',
    set: (v: string) => {
      if (v === '') cleared = true;
    },
  });

  // Bubbling: Svelte 5 delegates `change` to the root, as a real input's change does bubble.
  gallery.dispatchEvent(new Event('change', { bubbles: true }));

  expect(props.onFiles).toHaveBeenCalledWith([photo]);
  expect(cleared).toBe(true);
});

it('swaps the attachment chips for the formatting row, and formats through the caller', () => {
  const { target, props } = mountBar();
  const toggle = target.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
  // The first aria-pressed button in DOM order is the poll chip; the formatting toggle is the one
  // in the last row, next to the action.
  const formattingToggle = Array.from(
    target.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')
  ).at(-1)!;
  expect(toggle).not.toBe(formattingToggle);

  formattingToggle.click();
  flushSync();

  expect(fileInputs(target)).toHaveLength(0);
  const bold = target.querySelector<HTMLButtonElement>('[role="toolbar"] button')!;
  bold.click();
  expect(props.onFormat).toHaveBeenCalledWith('bold');
});

it('keeps focus in the editor: the Aa toggle and EVERY formatting chip refuse the mousedown focus move', () => {
  // The owner's concern is the keyboard: a tap that moves focus off the editor closes it. A button
  // that stops preventing its mousedown fails here, not on a phone.
  const { target } = mountBar();
  const aa = Array.from(target.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).at(-1)!;
  const downOn = (el: Element) => {
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    el.dispatchEvent(down);
    return down.defaultPrevented;
  };
  expect(downOn(aa)).toBe(true);

  aa.click();
  flushSync();
  const chips = Array.from(target.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button'));
  expect(chips).toHaveLength(8);
  for (const chip of chips) expect(downOn(chip)).toBe(true);
  // The strip between two chips is part of the toolbar: a tap there must not blur either.
  expect(downOn(target.querySelector('[role="toolbar"]')!)).toBe(true);
  // No pointerdown handler exists to keep in step: the compatibility mousedown is the only gate.
});

it('clears the height floor when Aa is toggled twice, the chips back at their natural height', () => {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).hasAttribute('data-chip-row') ? 132 : 0;
    },
  });
  try {
    const { target } = mountBar();
    flushSync();
    const aa = () =>
      Array.from(target.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).at(-1)!;
    aa().click();
    flushSync();
    expect(
      (target.querySelector('[role="toolbar"]')!.parentElement as HTMLElement).style.minHeight
    ).toBe('132px');

    aa().click();
    flushSync();
    expect(target.querySelector('[role="toolbar"]')).toBeNull();
    const row = target.querySelector<HTMLElement>('[data-chip-row]')!;
    expect(row.parentElement!.style.minHeight).toBe('');
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original);
  }
});

it.each([
  ['the NEW-post composer (reel set): its filmed video may become a CanaReel', true, 'post'],
  ['the post EDITOR (no reel): every take is attached', false, 'post-edit'],
] as const)(
  'has ONE camera chip, a button opening the in-app overlay - %s',
  (_, isNew, destination) => {
    const reel = { caption: '', identity: '', onpublished: vi.fn() };
    const { target } = mountBar(isNew ? { reel } : {});
    expect(target.querySelectorAll('input[capture]')).toHaveLength(0);
    const chips = target.querySelectorAll<HTMLButtonElement>('button[data-post-camera]');
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent?.trim()).toBe('Ouvrir la caméra');

    chips[0].click();
    flushSync();

    expect(
      document.querySelector('[data-camera-overlay]')?.getAttribute('data-camera-overlay')
    ).toBe(destination);
  }
);

it('in the iOS app "Photo/video" is the native library: no input WebKit would answer with its camera', async () => {
  runtime.iosApp = true;
  const photo = new File(['x'], 'IMG_1.jpg', { type: 'image/jpeg' });
  pickNatively.mockResolvedValue([photo]);
  const { target, props } = mountBar();

  expect(target.querySelectorAll('input[accept*="image"], input[accept*="video"]')).toHaveLength(0);
  target.querySelector<HTMLButtonElement>('button[data-post-library]')!.click();
  await Promise.resolve();
  await Promise.resolve();

  expect(pickNatively).toHaveBeenCalledWith('library');
  expect(props.onFiles).toHaveBeenCalledWith([photo]);
});

it('draws the "Live" chip only when the composer offers a live, and a tap opens it', () => {
  const without = mountBar();
  expect(without.target.querySelector('[data-post-live]')).toBeNull();
  const onLive = vi.fn();
  const { target } = mountBar({ onLive });
  const chip = target.querySelector<HTMLButtonElement>('[data-post-live]')!;
  expect(chip.tagName).toBe('BUTTON');
  chip.click();
  expect(onLive).toHaveBeenCalledTimes(1);
});

it('disables every attach chip at the cap and shows the count', () => {
  const { target } = mountBar({ attachmentCount: 10 });
  expect(fileInputs(target).every((i) => i.disabled)).toBe(true);
  expect(target.querySelector<HTMLButtonElement>('[data-post-camera]')!.disabled).toBe(true);
  expect(target.querySelector('[data-attachment-counter]')!.textContent).toBe(
    m.post_attachments_counter({ count: 10, max: 10 })
  );
});

it('keeps the attach chips usable below the cap', () => {
  const { target } = mountBar({ attachmentCount: 9 });
  expect(fileInputs(target).some((i) => i.disabled)).toBe(false);
  expect(target.querySelector<HTMLButtonElement>('[data-post-camera]')!.disabled).toBe(false);
});

it('wraps the chip row instead of clipping it, so every chip is reachable at any width', () => {
  const { target } = mountBar();
  const row = target.querySelector<HTMLElement>('[data-chip-row]')!;
  expect(row.className).toContain('flex-wrap');
  expect(row.className).not.toMatch(/overflow-(x-)?(hidden|auto|scroll)/);
});

it('draws the formatting actions as labelled chips of the same class, so "Aa" is a same-size swap', () => {
  const { target } = mountBar();
  const chipClassOf = (el: Element) => el.className;
  const attach = target.querySelector<HTMLButtonElement>('button[data-post-camera]')!;
  Array.from(target.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).at(-1)!.click();
  flushSync();

  const buttons = Array.from(target.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button'));
  expect(buttons).toHaveLength(8);
  // Every action carries its WORD, not only an icon, and wears the attachment chips' class.
  for (const b of buttons) {
    expect(b.textContent?.trim()).toBeTruthy();
    expect(chipClassOf(b)).toContain('rounded-full');
  }
  expect(chipClassOf(buttons[0])).toContain(
    chipClassOf(attach)
      .split(' ')
      .find((c) => c.startsWith('px-'))!
  );
  // They wrap like the chips instead of scrolling sideways.
  expect(target.querySelector('[role="toolbar"]')!.className).toContain('flex-wrap');
});

it('holds the height of the chip row while the formatting row replaces it', () => {
  // The two wrappings can differ by a few points; the floor keeps the swap from moving anything. The
  // height is read when the row is drawn, so the layout answer is stubbed before the mount.
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).hasAttribute('data-chip-row') ? 132 : 0;
    },
  });
  try {
    const { target } = mountBar();
    flushSync();
    Array.from(target.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).at(-1)!.click();
    flushSync();

    const slot = target.querySelector('[role="toolbar"]')!.parentElement as HTMLElement;
    expect(slot.style.minHeight).toBe('132px');
  } finally {
    if (original) Object.defineProperty(HTMLElement.prototype, 'clientHeight', original);
  }
});
