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
}

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
  const panelWidth = Math.min(panel.offsetWidth || 352, window.innerWidth - margin * 2);
  const panelHeight = panel.offsetHeight || estimatedHeight;

  const spaceBelow = window.innerHeight - anchorRect.bottom - margin;
  const spaceAbove = anchorRect.top - margin;
  const side: FixedPopoverSide =
    spaceBelow >= Math.min(panelHeight, estimatedHeight) + offset || spaceBelow >= spaceAbove
      ? 'bottom'
      : 'top';

  const maxHeight = Math.max(
    160,
    Math.min(estimatedHeight, side === 'bottom' ? spaceBelow - offset : spaceAbove - offset)
  );

  const top =
    side === 'bottom'
      ? anchorRect.bottom + offset
      : Math.max(margin, anchorRect.top - offset - Math.min(panelHeight, maxHeight));

  let left = options.alignEnd ? anchorRect.right - panelWidth : anchorRect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - panelWidth - margin));

  return { top, left, maxHeight, side };
}

/** Keeps a `position: fixed` popover inside the viewport while scrolling/resizing. */
export function bindFixedPopover(panel: HTMLElement, options: FixedPopoverOptions): () => void {
  const apply = () => {
    const anchor = options.anchor();
    if (!anchor) return;
    const { top, left, maxHeight, side } = computeFixedPopoverPosition(anchor, panel, options);
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
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
