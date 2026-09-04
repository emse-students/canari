export type FixedPopoverSide = 'top' | 'bottom';

export interface FixedPopoverLayoutOptions {
  /** When true, align the popover's right edge with the anchor's right edge. */
  alignEnd?: boolean;
  /** Gap between anchor and popover in px. */
  offset?: number;
  /** Minimum viewport margin in px. */
  margin?: number;
  /** Estimated height before layout (used for flip decision). */
  estimatedHeight?: number;
  /**
   * When true, the popover takes the anchor's width instead of its own - what a dropdown
   * anchored to an input needs, since `w-full` no longer resolves once it is portalled out.
   */
  matchAnchorWidth?: boolean;
}

export interface FixedPopoverOptions extends FixedPopoverLayoutOptions {
  /** Element the popover is anchored to (e.g. message row). */
  anchor: () => HTMLElement | null;
}

export interface FixedPopoverPosition {
  top: number;
  left: number;
  maxHeight: number;
  side: FixedPopoverSide;
  /** Width the panel was laid out against - the anchor's under `matchAnchorWidth`, its own otherwise. */
  width: number;
}

/**
 * Below this, a popover shows nothing anybody can use - a header and a clipped first row.
 *
 * It is a PREFERENCE, not a limit: when the chosen side has less room than this, the panel keeps the
 * height and is moved into the viewport instead of being shrunk into uselessness. Only the viewport
 * itself is a hard limit.
 */
const MIN_USEFUL_HEIGHT = 160;

/** Computes viewport-safe fixed coordinates for a popover panel. */
export function computeFixedPopoverPosition(
  anchor: HTMLElement,
  panel: HTMLElement,
  options: FixedPopoverLayoutOptions = {}
): FixedPopoverPosition {
  const offset = options.offset ?? 8;
  const margin = options.margin ?? 8;
  const estimatedHeight = options.estimatedHeight ?? 360;

  const anchorRect = anchor.getBoundingClientRect();
  const panelWidth = Math.min(
    options.matchAnchorWidth ? anchorRect.width : panel.offsetWidth || 352,
    window.innerWidth - margin * 2
  );
  const panelHeight = panel.offsetHeight || estimatedHeight;

  const spaceBelow = window.innerHeight - anchorRect.bottom - margin;
  const spaceAbove = anchorRect.top - margin;
  const side: FixedPopoverSide =
    spaceBelow >= Math.min(panelHeight, estimatedHeight) + offset || spaceBelow >= spaceAbove
      ? 'bottom'
      : 'top';

  // THE FLOOR MAY EXCEED THE SPACE ON THE CHOSEN SIDE, AND THAT IS DELIBERATE - a panel smaller
  // than `MIN_USEFUL_HEIGHT` shows nothing usable, so it is better to keep the height and MOVE the
  // panel, which is what the clamp below does. What the floor may never exceed is the VIEWPORT:
  // there is nowhere to move a panel taller than the screen.
  const maxHeight = Math.min(
    estimatedHeight,
    window.innerHeight - margin * 2,
    Math.max(MIN_USEFUL_HEIGHT, side === 'bottom' ? spaceBelow - offset : spaceAbove - offset)
  );

  // THE VERTICAL AXIS IS CLAMPED INTO THE VIEWPORT, EXACTLY AS THE HORIZONTAL ONE ALREADY WAS.
  // That asymmetry was the whole defect behind "the panel often renders partly off-screen": `left`
  // has been clamped to `[margin, innerWidth - width - margin]` since this was written, while `top`
  // was only ever floored at `margin` - so a panel opening downward into a gap smaller than the
  // floor above was placed at `anchor.bottom + offset` and simply hung off the bottom of the screen,
  // where its content is unreachable and its own scrolling cannot help. Sliding it up is what every
  // popover does, and it needs no new number.
  const height = Math.min(panelHeight, maxHeight);
  let top = side === 'bottom' ? anchorRect.bottom + offset : anchorRect.top - offset - height;
  top = Math.max(margin, Math.min(top, window.innerHeight - margin - height));

  let left = options.alignEnd ? anchorRect.right - panelWidth : anchorRect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - panelWidth - margin));

  return { top, left, maxHeight, side, width: panelWidth };
}

/** Keeps a `position: fixed` popover inside the viewport while scrolling/resizing. */
export function bindFixedPopover(panel: HTMLElement, options: FixedPopoverOptions): () => void {
  const apply = () => {
    const anchor = options.anchor();
    if (!anchor) return;
    const { top, left, maxHeight, side, width } = computeFixedPopoverPosition(
      anchor,
      panel,
      options
    );
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
    // Only written when asked for: pinning a panel to its own measured width would freeze
    // whatever responsive sizing its classes describe.
    if (options.matchAnchorWidth) panel.style.width = `${width}px`;
    panel.style.maxHeight = `${maxHeight}px`;
    panel.style.setProperty('--popover-max-h', `${maxHeight}px`);
    panel.dataset.popoverSide = side;
  };

  apply();
  const ro = new ResizeObserver(apply);
  ro.observe(panel);
  window.addEventListener('resize', apply);
  window.addEventListener('scroll', apply, true);

  return () => {
    ro.disconnect();
    window.removeEventListener('resize', apply);
    window.removeEventListener('scroll', apply, true);
  };
}
