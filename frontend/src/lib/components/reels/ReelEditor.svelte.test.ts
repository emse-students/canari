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

// The full picker fetches its dataset over the network; this suite only asks that it opens.
vi.mock('$lib/utils/emojiCatalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/emojiCatalog')>()),
  loadEmojiCatalog: () => Promise.resolve([]),
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
  localStorage.clear();
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

it('styles a text: the font and the pill apply to the selected text at once, and a new text starts with them', () => {
  const target = mountEditor();
  const pill = () => target.querySelector<HTMLButtonElement>('[data-reel-pill]');
  expect(pill()).toBeNull();
  target.querySelector<HTMLButtonElement>('[data-reel-tool-text]')!.click();
  flushSync();
  // The row is there while composing: choose before writing.
  target.querySelector<HTMLButtonElement>('[data-reel-font="serif"]')!.click();
  pill()!.click();
  flushSync();
  const input = target.querySelector<HTMLInputElement>('form input')!;
  input.value = 'salut';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  target
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  flushSync();
  const span = () => overlay(target).querySelector<HTMLElement>('span')!;
  expect(span().style.fontFamily).toContain('serif');
  expect(span().style.borderRadius).not.toBe('');
  // The selected text keeps the row; switching the pill off restyles it in place.
  pill()!.click();
  target.querySelector<HTMLButtonElement>('[data-reel-font="mono"]')!.click();
  flushSync();
  expect(span().style.borderRadius).toBe('');
  expect(span().style.fontFamily).toContain('monospace');
  // No text selected, no row.
  const frame = target.querySelector('[data-reel-frame]')!;
  fire(frame, 'pointerdown', 1, 5, 5);
  expect(pill()).toBeNull();
});

function drawLine(target: HTMLElement, id = 1) {
  const frame = target.querySelector('[data-reel-frame]')!;
  fire(frame, 'pointerdown', id, 40, 100);
  fire(frame, 'pointermove', id, 100, 100);
  fire(frame, 'pointermove', id, 160, 100);
  fire(frame, 'pointerup', id, 160, 100);
}

const strokes = (target: HTMLElement) =>
  target.querySelectorAll<HTMLElement>('[data-overlay-kind="stroke"]');
const tool = (target: HTMLElement, name: string) =>
  target.querySelector<HTMLButtonElement>(`[data-reel-tool-${name}]`)!;

it('draws a stroke that is an overlay, undoes it, and clears nothing it should not', () => {
  const target = mountEditor();
  expect(tool(target, 'undo').disabled).toBe(true);
  expect(tool(target, 'clear').disabled).toBe(true);
  tool(target, 'draw').click();
  flushSync();
  target.querySelector<HTMLButtonElement>('[data-reel-width="2"]')!.click();
  flushSync();
  drawLine(target);
  expect(strokes(target)).toHaveLength(1);
  // Centred on the middle of the path: (100, 100) of a 200x400 frame.
  expect(strokes(target)[0].getAttribute('style')).toContain('left: 50%');
  expect(strokes(target)[0].getAttribute('style')).toContain('top: 25%');
  expect(strokes(target)[0].querySelector('polyline')!.getAttribute('stroke-width')).toBe('0.024');
  expect(tool(target, 'undo').disabled).toBe(false);
  tool(target, 'undo').click();
  flushSync();
  expect(strokes(target)).toHaveLength(0);
  expect(tool(target, 'undo').disabled).toBe(true);
});

it('a drawn stroke moves like any overlay, and that move is undone first', () => {
  const target = mountEditor();
  tool(target, 'draw').click();
  flushSync();
  drawLine(target);
  tool(target, 'draw').click();
  flushSync();
  const frame = target.querySelector('[data-reel-frame]')!;
  fire(strokes(target)[0], 'pointerdown', 1, 100, 100);
  fire(frame, 'pointermove', 1, 100, 200);
  fire(frame, 'pointerup', 1, 100, 200);
  expect(strokes(target)[0].getAttribute('style')).toContain('top: 50%');
  tool(target, 'undo').click();
  flushSync();
  expect(strokes(target)[0].getAttribute('style')).toContain('top: 25%');
  expect(strokes(target)).toHaveLength(1);
});

it('erases only the strokes the finger crosses, as one undo step', () => {
  const target = mountEditor();
  tool(target, 'draw').click();
  flushSync();
  drawLine(target);
  const frame = target.querySelector('[data-reel-frame]')!;
  fire(frame, 'pointerdown', 1, 40, 300);
  fire(frame, 'pointermove', 1, 100, 300);
  fire(frame, 'pointermove', 1, 160, 300);
  fire(frame, 'pointerup', 1, 160, 300);
  expect(strokes(target)).toHaveLength(2);
  tool(target, 'erase').click();
  flushSync();
  fire(frame, 'pointerdown', 1, 100, 98);
  fire(frame, 'pointermove', 1, 101, 99);
  fire(frame, 'pointerup', 1, 101, 99);
  expect(strokes(target)).toHaveLength(1);
  expect(strokes(target)[0].getAttribute('style')).toContain('top: 75%');
  tool(target, 'undo').click();
  flushSync();
  expect(strokes(target)).toHaveLength(2);
});

it('clears everything in one undoable step, and a tap-drawn dot adds nothing', () => {
  const target = mountEditor();
  addEmoji(target);
  tool(target, 'draw').click();
  flushSync();
  const frame = target.querySelector('[data-reel-frame]')!;
  fire(frame, 'pointerdown', 1, 40, 100);
  fire(frame, 'pointerup', 1, 40, 100);
  expect(strokes(target)).toHaveLength(0);
  drawLine(target);
  tool(target, 'clear').click();
  flushSync();
  expect(target.querySelectorAll('[data-overlay-id]')).toHaveLength(0);
  tool(target, 'undo').click();
  flushSync();
  expect(target.querySelectorAll('[data-overlay-id]')).toHaveLength(2);
});

it('puts the emoji just used first on the shelf, and opens the full picker on demand', () => {
  const target = mountEditor();
  addEmoji(target, 5);
  const used = QUICK_EMOJI[5];
  tool(target, 'emoji').click();
  flushSync();
  const first = target.querySelector<HTMLButtonElement>('[role="group"] button')!;
  expect(first.getAttribute('aria-label')).toContain(used);
  expect(target.querySelector('[data-reel-emoji-grid]')).toBeNull();
  target.querySelector<HTMLButtonElement>('[data-reel-emoji-all]')!.click();
  flushSync();
  expect(target.querySelector('[data-reel-emoji-grid]')).not.toBeNull();
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
