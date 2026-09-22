/**
 * WHETHER AN ELEMENT IS SHOWING ITS TEXT IN FULL, MEASURED RATHER THAN ESTIMATED.
 *
 * Written 2026-09-22 to replace a character count. The responses table decided whether a row keeps
 * the control that opens its answers by comparing an answer's LENGTH to a constant derived from a
 * cell's width and an average glyph - twenty-five characters. A reader met rows that expanded and
 * rows that did not with no visible rule between them, because there is none: the same twenty-six
 * characters fit in one font and not in another, at one zoom and not at another, on one browser's
 * ellipsis and not on another's.
 *
 * `scrollWidth > clientWidth` is the browser's own answer to the question, and it is the ONLY answer
 * that cannot be wrong. It costs a `ResizeObserver` per watched element, which is why this reports
 * rather than returning: the caller collects the verdicts it needs and asks nothing of the rest.
 *
 * IT MEASURES ON MOUNT, ON RESIZE AND ON TEXT CHANGE. The third is not covered by the first two: a
 * clipped element's border box does NOT change when its content does, so an observer alone would
 * hold a verdict about text that is no longer there.
 */
export interface ClipReport {
  /** Identifies this element to the caller across renders. */
  key: string;
  /** The text the element carries. Never read - it is what makes a re-measure necessary. */
  text: string;
  /** Receives every verdict, including `false` when the element is destroyed. */
  onMeasure: (key: string, clipped: boolean) => void;
}

export function reportClipped(node: HTMLElement, params: ClipReport) {
  let current = params;

  const measure = () => current.onMeasure(current.key, node.scrollWidth > node.clientWidth);

  const observer = new ResizeObserver(measure);
  observer.observe(node);
  measure();

  return {
    update(next: ClipReport) {
      // A key that moved leaves a verdict behind under the old one, so it is retracted first.
      if (next.key !== current.key) current.onMeasure(current.key, false);
      current = next;
      measure();
    },
    destroy() {
      observer.disconnect();
      current.onMeasure(current.key, false);
    },
  };
}
