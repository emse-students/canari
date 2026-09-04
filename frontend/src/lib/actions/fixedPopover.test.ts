import { computeFixedPopoverPosition } from './fixedPopover';

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
