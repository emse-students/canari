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
});
