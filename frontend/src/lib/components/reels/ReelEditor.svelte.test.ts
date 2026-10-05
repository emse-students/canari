/**
 * The editor's overlay gestures, through the real component: add, select, drag, pinch/twist, drop
 * on the trash, deselect, and what "apply" hands to the export. The arithmetic of the gesture is
 * pinned in `transformGesture.test.ts`; what is pinned HERE is that the component wires it - and
 * that the layout is one column with nothing floating over the stage.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReelEditor from './ReelEditor.svelte';
import { QUICK_EMOJI } from '$lib/reels/reelOverlays';

const render = vi.hoisted(() => vi.fn());
vi.mock('$lib/reels/reelEditor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/reels/reelEditor')>()),
  renderEditedReelMedia: render,
}));

const mounted: Record<string, unknown>[] = [];

const FRAME = { left: 0, top: 0, right: 200, bottom: 400, width: 200, height: 400 };
const TRASH = { left: 80, top: 330, right: 120, bottom: 390, width: 40, height: 60 };

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:take', revokeObjectURL: () => {} })
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const box = this.hasAttribute('data-reel-trash')
      ? TRASH
      : this.hasAttribute('data-reel-frame')
        ? FRAME
        : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    return { ...box, x: box.left, y: box.top, toJSON: () => box } as DOMRect;
  });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  render.mockReset();
  render.mockResolvedValue({ blob: new Blob(['edited']), width: 1, height: 1 });
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountEditor(props: Record<string, unknown> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(ReelEditor, {
      target,
      props: {
        clip: { blob: new Blob(['x'], { type: 'image/webp' }), source: 'camera' },
        oncancel: () => {},
        onapply: () => {},
        ...props,
      },
    })
  );
  flushSync();
  return target;
}

function fire(el: Element, type: string, id: number, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerId', { value: id });
  el.dispatchEvent(event);
  flushSync();
}

function addEmoji(target: HTMLElement, index = 0) {
  target.querySelector<HTMLButtonElement>('[data-reel-tool-emoji]')!.click();
  flushSync();
  const buttons = target.querySelectorAll<HTMLButtonElement>('[role="group"] button');
  buttons[index].click();
  flushSync();
}

const overlay = (target: HTMLElement) => target.querySelector<HTMLElement>('[data-overlay-id]')!;

it('lays the editor out as one column: header, stage, tools - nothing floats over the stage', () => {
  const target = mountEditor();
  const root = target.querySelector('[data-reel-editor]')!;
  expect(root.className).toContain('flex-col');
  const tools = target.querySelector('[data-reel-tool-text]')!.closest('div.flex-col')!;
  expect(tools.className).not.toContain('absolute');
  expect(tools.className).toContain('safe-area-inset-bottom');
  expect(tools.parentElement).toBe(root);
});

it('adds an emoji from the tray, selected, centred and upright', () => {
  const target = mountEditor();
  addEmoji(target, 3);
  const el = overlay(target);
  expect(el.dataset.overlayKind).toBe('emoji');
  expect(el.getAttribute('style')).toContain('left: 50%');
  expect(el.getAttribute('style')).toContain('rotate(0rad)');
  expect(el.className).toContain('outline-dashed');
  expect(el.querySelector('img')!.getAttribute('alt')).toBe(QUICK_EMOJI[3]);
});

it('drags with one finger, and a tap on empty space deselects', () => {
  const target = mountEditor();
  addEmoji(target);
  const frame = target.querySelector('[data-reel-frame]')!;
  fire(overlay(target), 'pointerdown', 1, 100, 200);
  fire(frame, 'pointermove', 1, 140, 240);
  fire(frame, 'pointerup', 1, 140, 240);
  expect(overlay(target).getAttribute('style')).toContain('left: 70%');
  expect(overlay(target).getAttribute('style')).toContain('top: 60%');

  fire(frame, 'pointerdown', 2, 10, 10);
  fire(frame, 'pointerup', 2, 10, 10);
  expect(overlay(target).className).not.toContain('outline-dashed');
});

it('pinches and twists with a second finger that lands anywhere', () => {
  const target = mountEditor();
  addEmoji(target);
  const frame = target.querySelector('[data-reel-frame]')!;
  const before = overlay(target).dataset.overlayScale;
  fire(overlay(target), 'pointerdown', 1, 100, 200);
  fire(frame, 'pointerdown', 2, 140, 200); // lands on empty space, joins the gesture
  fire(frame, 'pointermove', 2, 100, 240); // a quarter turn, same distance
  expect(overlay(target).getAttribute('style')).toMatch(/rotate\(1\.5\d+rad\)/);
  fire(frame, 'pointermove', 2, 100, 320); // twice as far
  fire(frame, 'pointerup', 2, 100, 320);
  fire(frame, 'pointerup', 1, 100, 200);
  expect(before).toBe('1.000');
  // 40 px between the fingers became 120: three times the size.
  expect(overlay(target).dataset.overlayScale).toBe('3.000');
});

it('deletes an overlay released over the trash, and not one released elsewhere', () => {
  const target = mountEditor();
  addEmoji(target);
  const frame = target.querySelector('[data-reel-frame]')!;
  expect(target.querySelector('[data-reel-trash]')).toBeNull();
  fire(overlay(target), 'pointerdown', 1, 100, 200);
  fire(frame, 'pointermove', 1, 100, 300);
  expect(target.querySelector('[data-reel-trash]')).not.toBeNull();
  fire(frame, 'pointerup', 1, 100, 300);
  expect(target.querySelectorAll('[data-overlay-id]')).toHaveLength(1);
  expect(target.querySelector('[data-reel-trash]')).toBeNull();

  fire(overlay(target), 'pointerdown', 1, 100, 300);
  fire(frame, 'pointermove', 1, 100, 360);
  fire(frame, 'pointerup', 1, 100, 360); // inside the trash rect
  expect(target.querySelectorAll('[data-overlay-id]')).toHaveLength(0);
});

it('a cancelled gesture never deletes', () => {
  const target = mountEditor();
  addEmoji(target);
  const frame = target.querySelector('[data-reel-frame]')!;
  fire(overlay(target), 'pointerdown', 1, 100, 200);
  fire(frame, 'pointermove', 1, 100, 360);
  fire(frame, 'pointercancel', 1, 100, 360);
  expect(target.querySelectorAll('[data-overlay-id]')).toHaveLength(1);
});

it('adds a text through the field, and edits it by tapping it once selected', () => {
  const target = mountEditor();
  target.querySelector<HTMLButtonElement>('[data-reel-tool-text]')!.click();
  flushSync();
  const input = target.querySelector<HTMLInputElement>('form input')!;
  input.value = 'salut';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  target
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  flushSync();
  expect(overlay(target).dataset.overlayKind).toBe('text');
  expect(overlay(target).textContent!.trim()).toBe('salut');
  expect(target.querySelector('form')).toBeNull();

  const frame = target.querySelector('[data-reel-frame]')!;
  // Selected already (it was just created): a tap that does not move opens the field on its text.
  fire(overlay(target), 'pointerdown', 1, 100, 200);
  fire(frame, 'pointerup', 1, 100, 200);
  expect(target.querySelector<HTMLInputElement>('form input')!.value).toBe('salut');
});

it('hands the overlays to the export, and does not export when nothing was added', async () => {
  const cancelled = vi.fn();
  const applied = vi.fn();
  const target = mountEditor({ oncancel: cancelled, onapply: applied });
  target.querySelector<HTMLButtonElement>('[data-reel-editor-apply]')!.click();
  await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
  expect(render).not.toHaveBeenCalled();

  addEmoji(target);
  target.querySelector<HTMLButtonElement>('[data-reel-editor-apply]')!.click();
  await vi.waitFor(() => expect(applied).toHaveBeenCalled());
  const edits = render.mock.calls[0][1];
  expect(edits.overlays).toHaveLength(1);
  expect(edits.overlays[0]).toMatchObject({ kind: 'emoji', x: 0.5, y: 0.5, scale: 1, rotation: 0 });
});
