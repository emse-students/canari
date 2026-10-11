<script lang="ts">
  /**
   * The invisible, selectable text of one PDF page, laid over its bitmap.
   *
   * The reader rasterises pages because that is the only renderer every platform has (see
   * `utils/pdfDocument.ts`), and a bitmap is not text: selecting, copying and searching all
   * stopped working the moment a document was opened here rather than in a real PDF reader. This
   * is the standard answer, and the one pdf.js's own viewer uses - keep the bitmap, and put the
   * real characters on top of it, transparent and positioned.
   *
   * Two properties make it survive the reader's zoom, which re-rasterises the page underneath:
   *
   * 1. Every box is a FRACTION of the page (`pdfTextGeometry.ts`), so one extraction serves every
   *    zoom step, column width and device pixel ratio. Nothing here is recomputed on a re-render.
   * 2. Sizes are `em` against a font-size set to the page HEIGHT, so the whole layer scales with
   *    the page by CSS alone - no measurement, no resize observer, and nothing to go stale between
   *    a relayout and the next frame.
   */
  import { horizontalScale, type TextRunBox } from '$lib/utils/pdfTextGeometry';

  interface Props {
    /** Runs of this page, in page fractions. */
    runs: readonly (TextRunBox & { text: string })[];
    /** Rendered height of the page box in CSS pixels - the unit every `em` below resolves against. */
    pageHeight: number;
    /** Rendered width of the page box in CSS pixels, needed to turn a width fraction into `em`. */
    pageWidth: number;
  }

  let { runs, pageHeight, pageWidth }: Props = $props();

  /**
   * Stretches every span onto the width its run really occupies.
   *
   * The browser lays the characters out in a substituted font, so a span's natural width is never
   * the PDF's. Selection highlights follow the SPAN, so without this they drift further from the
   * glyphs with every word.
   *
   * Re-measured, once per frame, whenever the page width changes. The ratio would be invariant if
   * text scaled exactly linearly, which a minimum font size and glyph hinting do not promise, and
   * one batched layout per page on screen is cheap enough not to bet on it.
   *
   * ALL READS, THEN ALL WRITES. This used to be one action per span, each writing its transform
   * and the next one reading its width: a forced layout per span, hundreds per page of a scan with
   * an OCR layer - a ~1 s long task each time a page came near, and 11-13 s per zoom click once
   * every page carried its layer (Mi 9T, 2026-10-11). Batched, it is one layout per page.
   */
  function fitWidths(layer: HTMLElement, width: number) {
    let frame = 0;
    const fit = () => {
      frame = 0;
      const spans = Array.from(layer.querySelectorAll<HTMLElement>('span[data-run]'));
      for (const span of spans) span.style.transform = '';
      // The target is read off the layer in the SAME layout as the spans, never taken from the
      // prop: on a zoom the prop and the layer's font size reach the DOM in different updates, and
      // a fit between the two made every span 24 % too wide at x1.5 (Mi 9T, 2026-10-11).
      const pageWidthPx = layer.getBoundingClientRect().width;
      const naturals = spans.map((span) => span.getBoundingClientRect().width);
      spans.forEach((span, i) => {
        const run = runs[Number(span.dataset.run)];
        if (!run) return;
        const scaleX = horizontalScale(run.width * pageWidthPx, naturals[i]);
        span.style.transform = `rotate(${run.angle}rad) scaleX(${scaleX})`;
      });
    };
    /** One fit per frame, after every update of that frame has reached the DOM. */
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(fit);
    };
    schedule();
    return {
      // The width is only the trigger; `fit` measures what is actually laid out.
      update: (next: number) => {
        if (next !== width) {
          width = next;
          schedule();
        }
      },
      destroy: () => cancelAnimationFrame(frame),
    };
  }
</script>

<!--
  `pointer-events: none` on the layer with `auto` on the spans: the gaps between runs must stay
  transparent to the pinch and the scroll handlers on the container above, or a document would
  become impossible to scroll by dragging anywhere text happens to be.
-->
<div
  class="pdf-text-layer pointer-events-none absolute inset-0 select-text"
  style="font-size: {pageHeight}px;"
  aria-hidden="true"
  use:fitWidths={pageWidth}
>
  {#each runs as run, index (index)}
    <span
      class="pointer-events-auto absolute origin-top-left whitespace-pre text-transparent"
      data-run={index}
      style="left: {run.left * 100}%; top: {run.top * 100}%; font-size: {run.fontHeight}em;"
      >{run.text}</span
    >
  {/each}
</div>

<style>
  /*
   * The selection highlight is the ONLY thing a user sees of this layer, so it is drawn explicitly
   * rather than left to the browser's default over transparent text - which renders as a barely
   * visible tint on the white page underneath on some engines and not at all on others.
   */
  .pdf-text-layer ::selection {
    background: rgb(59 130 246 / 0.35);
  }
</style>
