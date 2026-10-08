/**
 * WHETHER A LINE-CLAMPED BLOCK IS ACTUALLY CUT, MEASURED RATHER THAN ESTIMATED.
 *
 * A comment showed "Voir plus" when its text passed 280 characters, but the box is clamped at five
 * LINES: a 300-character comment fits four lines on a wide column, so the control opened nothing and
 * read as broken (user report, web, 2026-10-08). `scrollHeight > clientHeight` is the browser's own
 * answer, and the only one that holds at every width, font and zoom.
 *
 * It measures only WHILE the clamp is active: expanded, the box shows everything and would report
 * "not cut", so the last verdict is kept and the caller keeps its "Voir moins". It re-measures on
 * resize and when the text changes (a clamped box's border box does not move when its content does).
 */
export interface LineClampReport {
  /** True while the clamp applies; false (expanded) freezes the verdict. */
  active: boolean;
  /** The text the block carries. Never read - it is what makes a re-measure necessary. */
  text: string;
  /** Receives the verdict whenever it is measured. */
  onMeasure: (clipped: boolean) => void;
}

export function reportLineClamp(node: HTMLElement, params: LineClampReport) {
  let current = params;

  const measure = () => {
    if (!current.active) return;
    current.onMeasure(node.scrollHeight > node.clientHeight + 1);
  };

  const observer = new ResizeObserver(measure);
  observer.observe(node);
  measure();

  return {
    update(next: LineClampReport) {
      current = next;
      measure();
    },
    destroy() {
      observer.disconnect();
    },
  };
}
