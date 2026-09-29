/**
 * THE COMPOSER BAR - which chooser each attachment asks the OS for, and that a pick only ADDS.
 *
 * The accept list is the whole fix for the photo button that opened Android's generic file
 * browser: one input accepting images, video, audio, PDF and Office together cannot be answered
 * with a photo picker. So the property pinned here is the attribute each input carries - the OS
 * reads nothing else - and that `capture` is on the two camera inputs and nowhere else.
 *
 * The reset is pinned because the callers APPEND: an input that kept its selection would hand the
 * previous pick over again on the next change, and the composer would show every photo twice.
 */
import { it, expect, afterEach, vi } from 'vitest';
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import PostComposerBar from './PostComposerBar.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
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

it('asks photos, the two cameras and documents from four separate choosers', () => {
  const { target } = mountBar();
  const inputs = fileInputs(target).map((i) => ({
    accept: i.getAttribute('accept'),
    capture: i.getAttribute('capture'),
  }));

  expect(inputs).toEqual([
    { accept: 'image/*,video/*', capture: null },
    { accept: 'image/*', capture: 'environment' },
    { accept: 'video/*', capture: 'environment' },
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

it('keeps focus in the editor when a formatting button is pressed', () => {
  const { target } = mountBar();
  Array.from(target.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')).at(-1)!.click();
  flushSync();

  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  target.querySelector('[role="toolbar"] button')!.dispatchEvent(down);

  expect(down.defaultPrevented).toBe(true);
});
