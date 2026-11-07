import type { GuideRect } from './guideAnchors.svelte';
import type { GuidePlacement } from './guideTypes';

/**
 * WHERE THE BUBBLE GOES - a pure function of the target's box, the bubble's size and the viewport,
 * so it is tested without a layout engine.
 *
 * `auto` takes the side with the most room, preferring below then above (a phone's targets are bars
 * at the top and bottom edges) and the side of a desktop rail. The bubble is then clamped inside the
 * viewport with `gutter` on every edge, so it never runs off a 320 px screen.
 */
export interface BubbleSize {
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface BubblePosition {
  readonly left: number;
  readonly top: number;
  /** The side the bubble ended on, for the arrow and the entrance direction. */
  readonly side: 'top' | 'bottom' | 'left' | 'right' | 'center';
}

/** The room on each side of the target, inside the viewport. */
function room(target: GuideRect, viewport: Viewport) {
  return {
    top: target.top,
    bottom: viewport.height - (target.top + target.height),
    left: target.left,
    right: viewport.width - (target.left + target.width),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function placeBubble(
  target: GuideRect | null,
  bubble: BubbleSize,
  viewport: Viewport,
  placement: GuidePlacement,
  gap: number,
  gutter: number
): BubblePosition {
  if (!target) {
    return {
      left: clamp(
        (viewport.width - bubble.width) / 2,
        gutter,
        viewport.width - bubble.width - gutter
      ),
      top: clamp(
        (viewport.height - bubble.height) / 2,
        gutter,
        viewport.height - bubble.height - gutter
      ),
      side: 'center',
    };
  }
  const r = room(target, viewport);
  const fitsV = (space: number) => space >= bubble.height + gap + gutter;
  const fitsH = (space: number) => space >= bubble.width + gap + gutter;
  let side: 'top' | 'bottom' | 'left' | 'right';
  if (placement !== 'auto') {
    side = placement;
  } else if (fitsV(r.bottom)) {
    side = 'bottom';
  } else if (fitsV(r.top)) {
    side = 'top';
  } else if (fitsH(r.right)) {
    side = 'right';
  } else if (fitsH(r.left)) {
    side = 'left';
  } else {
    // Nowhere fits whole: the larger vertical side, clamped, which keeps the target's row visible.
    side = r.bottom >= r.top ? 'bottom' : 'top';
  }
  const centreX = target.left + target.width / 2 - bubble.width / 2;
  const centreY = target.top + target.height / 2 - bubble.height / 2;
  const maxLeft = viewport.width - bubble.width - gutter;
  const maxTop = viewport.height - bubble.height - gutter;
  switch (side) {
    case 'bottom':
      return {
        left: clamp(centreX, gutter, maxLeft),
        top: clamp(target.top + target.height + gap, gutter, maxTop),
        side,
      };
    case 'top':
      return {
        left: clamp(centreX, gutter, maxLeft),
        top: clamp(target.top - gap - bubble.height, gutter, maxTop),
        side,
      };
    case 'right':
      return {
        left: clamp(target.left + target.width + gap, gutter, maxLeft),
        top: clamp(centreY, gutter, maxTop),
        side,
      };
    case 'left':
      return {
        left: clamp(target.left - gap - bubble.width, gutter, maxLeft),
        top: clamp(centreY, gutter, maxTop),
        side,
      };
  }
}

/** One computed corner radius ("8px", "50%", "8px 4px") as px: a percentage is read against the box. */
function cornerPx(value: string, box: { width: number; height: number }): number {
  const parts = value.trim().split(/\s+/);
  const px = (part: string, side: number): number =>
    part.endsWith('%') ? (parseFloat(part) / 100) * side : parseFloat(part);
  const horizontal = px(parts[0] ?? '', box.width);
  const vertical = px(parts[1] ?? parts[0] ?? '', box.height);
  return Math.min(horizontal, vertical);
}

/**
 * The spotlight's corner radius, CONCENTRIC with the control: the SMALLEST of its four computed
 * corner radii grown by the padding (a control with one square corner must not get a round ring),
 * capped at half the padded short side. `null` when no corner parses, so the CSS default applies.
 */
export function ringRadius(
  corners: readonly string[],
  box: { width: number; height: number },
  pad: number
): number | null {
  const radii = corners.map((corner) => cornerPx(corner, box)).filter(Number.isFinite);
  if (radii.length === 0) return null;
  return Math.min(Math.min(...radii) + pad, (Math.min(box.width, box.height) + 2 * pad) / 2);
}
