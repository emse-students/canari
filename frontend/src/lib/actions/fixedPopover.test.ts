import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindFixedPopover, computeFixedPopoverPosition } from './fixedPopover';

describe('computeFixedPopoverPosition', () => {
  beforeEach(() => {
    vi.stubGlobal('innerWidth', 400);
    vi.stubGlobal('innerHeight', 600);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens upward when there is little space below', () => {
    const anchor = {
      getBoundingClientRect: () => ({
        top: 500,
        bottom: 540,
        left: 100,
        right: 200,
        width: 100,
        height: 40,
        x: 100,
        y: 500,
        toJSON: () => ({}),
      }),
    } as HTMLElement;

    const panel = {
      offsetWidth: 320,
      offsetHeight: 360,
    } as HTMLElement;

    const pos = computeFixedPopoverPosition(anchor, panel, { estimatedHeight: 360 });
    expect(pos.side).toBe('top');
    expect(pos.top).toBeLessThan(500);
  });

  it('opens downward when there is room below', () => {
    const anchor = {
      getBoundingClientRect: () => ({
        top: 80,
        bottom: 120,
        left: 40,
        right: 180,
        width: 140,
        height: 40,
        x: 40,
        y: 80,
        toJSON: () => ({}),
      }),
    } as HTMLElement;

    const panel = {
      offsetWidth: 320,
      offsetHeight: 360,
    } as HTMLElement;

    const pos = computeFixedPopoverPosition(anchor, panel);
    expect(pos.side).toBe('bottom');
    expect(pos.top).toBeGreaterThanOrEqual(128);
  });

  it('takes the anchor width under matchAnchorWidth, ignoring the panel measurement', () => {
    const anchor = {
      getBoundingClientRect: () => ({
        top: 80,
        bottom: 120,
        left: 40,
        right: 180,
        width: 140,
        height: 40,
        x: 40,
        y: 80,
        toJSON: () => ({}),
      }),
    } as HTMLElement;

    // A portalled dropdown measures whatever its content is, never the field it belongs to.
    const panel = { offsetWidth: 320, offsetHeight: 100 } as HTMLElement;

    const pos = computeFixedPopoverPosition(anchor, panel, { matchAnchorWidth: true });
    expect(pos.width).toBe(140);
    // Left edge stays on the anchor: the wider panel measurement must not push it back inside.
    expect(pos.left).toBe(40);
  });

  /**
   * THE VERTICAL AXIS WAS NOT CLAMPED WHILE THE HORIZONTAL ONE WAS, and the emoji picker is where
   * the user met it: *"the panel frequently renders partly off-screen"*. `left` has always been
   * clamped into `[margin, innerWidth - width - margin]`; `top` was only floored at `margin`, so a
   * panel opening downward into a gap smaller than the useful-height floor was placed at
   * `anchor.bottom + offset` and hung off the bottom - where its content is unreachable and its own
   * scrolling cannot reach it either.
   */
  const anchorAt = (top: number, bottom: number) =>
    ({
      getBoundingClientRect: () => ({
        top,
        bottom,
        left: 40,
        right: 180,
        width: 140,
        height: bottom - top,
        x: 40,
        y: top,
        toJSON: () => ({}),
      }),
    }) as HTMLElement;

  it('slides a panel up rather than letting it hang off the bottom', () => {
    // THE GEOMETRY HAS TO PUT THE PANEL BELOW, WITH TOO LITTLE ROOM BELOW - and in a tall viewport
    // that pair cannot happen: the side choice already flips upward. It happens on a SHORT one,
    // which is a phone with its keyboard open. 200px of viewport, anchor 60-100: 92px below and
    // 52px above, so `bottom` wins on the comparison, and the floor still hands out 160. Placed at
    // `anchor.bottom + offset` that panel would run to 268 in a 200px window - 68px of it, with the
    // scroll affordance, off the screen entirely.
    vi.stubGlobal('innerHeight', 200);
    const panel = { offsetWidth: 320, offsetHeight: 160 } as HTMLElement;

    const pos = computeFixedPopoverPosition(anchorAt(60, 100), panel, { estimatedHeight: 360 });

    expect(pos.side).toBe('bottom');
    const height = Math.min(160, pos.maxHeight);
    expect(pos.top + height).toBeLessThanOrEqual(200 - 8);
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });

  it('never gives a panel more height than the viewport itself', () => {
    // The floor is a preference and the viewport is a limit: there is nowhere to move a panel
    // taller than the screen, so the one thing the floor may not do is exceed it.
    vi.stubGlobal('innerHeight', 120);
    const panel = { offsetWidth: 320, offsetHeight: 360 } as HTMLElement;

    const pos = computeFixedPopoverPosition(anchorAt(40, 60), panel, { estimatedHeight: 360 });

    expect(pos.maxHeight).toBeLessThanOrEqual(120 - 8 * 2);
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });

  it('still opens flush under the anchor when there IS room, and clamps nothing', () => {
    // The clamp must not move a panel that fits: this is the ordinary case, and a popover that
    // drifts away from its anchor is a different bug.
    const panel = { offsetWidth: 320, offsetHeight: 160 } as HTMLElement;

    const pos = computeFixedPopoverPosition(anchorAt(80, 120), panel, { estimatedHeight: 360 });

    expect(pos.side).toBe('bottom');
    expect(pos.top).toBe(128);
  });

  it('clamps an anchor wider than the viewport', () => {
    const anchor = {
      getBoundingClientRect: () => ({
        top: 80,
        bottom: 120,
        left: 0,
        right: 900,
        width: 900,
        height: 40,
        x: 0,
        y: 80,
        toJSON: () => ({}),
      }),
    } as HTMLElement;

    const panel = { offsetWidth: 900, offsetHeight: 100 } as HTMLElement;

    const pos = computeFixedPopoverPosition(anchor, panel, { matchAnchorWidth: true, margin: 8 });
    expect(pos.width).toBe(384);
    expect(pos.left).toBe(8);
  });
});

/**
 * A PANEL THIS ACTION POSITIONS MUST BE PORTALLED, OR ITS COORDINATES MEAN SOMETHING ELSE.
 *
 * Everything above computes viewport coordinates. `position: fixed` only resolves against the
 * viewport while no ancestor establishes a containing block - and `.page-scroll-wrap` carries
 * `will-change: transform` for the swipe-between-tabs gesture, which does exactly that for every
 * `fixed` descendant in the chat tree.
 *
 * MEASURED, NOT FEARED. On 2026-09-09 `MessageEmojiPicker` was anchored correctly and still opened
 * in the wrong place: the action wrote `left: 958.8px`, the right answer, and the panel painted at
 * 1055. Ninety-six pixels of wrapper offset added to a number that was already correct, which is why
 * it survived a fix to the anchor - the anchor was never the problem. The user saw it as the panel
 * not being "au meme endroit que le reste", the quick bar beside it being `absolute` and landing
 * where it is put.
 *
 * The rule is therefore a property of the ACTION, not of one component: whatever it positions leaves
 * the tree first. This is a source scan because there is nothing to run - the fault is invisible
 * until a specific ancestor exists above a specific component, and by then it is a bug report.
 */
describe('every panel bound to this action', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..');

  function svelteFiles(from: string, out: string[] = []): string[] {
    for (const entry of readdirSync(from)) {
      const full = join(from, entry);
      if (statSync(full).isDirectory()) svelteFiles(full, out);
      else if (entry.endsWith('.svelte')) out.push(full);
    }
    return out;
  }

  it('is portalled out of the tree, so its viewport coordinates mean the viewport', () => {
    const offenders = svelteFiles(dir)
      .map((file) => ({ file, body: readFileSync(file, 'utf8') }))
      .filter(({ body }) => body.includes('bindFixedPopover') && !body.includes('use:portal'))
      .map(({ file }) => relative(dir, file));

    expect(
      offenders,
      'These position a panel with viewport coordinates but leave it in the tree, where ' +
        '`will-change: transform` on an ancestor silently offsets it. Add `use:portal`: ' +
        offenders.join(', ')
    ).toEqual([]);
  });
});

/**
 * A ZERO-SIZED ANCHOR IS THE ONE INPUT THAT LOOKS VALID AND IS NOT.
 *
 * Every other bad anchor announces itself - `null` returns early, an off-screen one is clamped back
 * in. All-zeros passes every check: it is a legal rect describing a legal point, the window origin,
 * and the panel is placed neatly beside it in the corner. It is what `getBoundingClientRect()`
 * returns for a `display: none` node, which is how the reaction picker came to open in the top-left
 * of a 620px window while being correct at 900px and 1920px.
 */
describe('an anchor with no box', () => {
  const observed: unknown[] = [];

  beforeEach(() => {
    observed.length = 0;
    vi.stubGlobal('innerWidth', 400);
    vi.stubGlobal('innerHeight', 600);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function panelNode(): HTMLElement {
    const panel = document.createElement('div');
    Object.defineProperty(panel, 'offsetWidth', { value: 320 });
    Object.defineProperty(panel, 'offsetHeight', { value: 360 });
    return panel;
  }

  function anchorWith(width: number, height: number): HTMLElement {
    const anchor = document.createElement('div');
    anchor.getBoundingClientRect = () =>
      ({
        top: 100,
        bottom: 100 + height,
        left: 50,
        right: 50 + width,
        width,
        height,
        x: 50,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect;
    return anchor;
  }

  it('is refused rather than treated as the window origin', () => {
    const panel = panelNode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const unbind = bindFixedPopover(panel, { anchor: () => anchorWith(0, 0) });

    // Nothing written at all: a panel that was never placed must not LOOK placed.
    expect({
      top: panel.style.top,
      left: panel.style.left,
      warned: warn.mock.calls.length,
    }).toEqual({ top: '', left: '', warned: 1 });
    unbind();
  });

  it('accuses, because a silent refusal is the same bug one layer down', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    bindFixedPopover(panelNode(), { anchor: () => anchorWith(0, 0) })();

    expect(String(warn.mock.calls[0][0])).toContain('anchor has no box');
  });

  it('still positions against an anchor that is a line with no height', () => {
    // Not a width check: an inline anchor can legitimately measure 0 tall and still have a place.
    const panel = panelNode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const unbind = bindFixedPopover(panel, { anchor: () => anchorWith(120, 0) });

    expect({ left: panel.style.left, warned: warn.mock.calls.length }).toEqual({
      left: '50px',
      warned: 0,
    });
    unbind();
  });
});
