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
   * Stretches a span onto the width its run really occupies.
   *
   * The browser lays the characters out in a substituted font, so a span's natural width is never
   * the PDF's. Selection highlights follow the SPAN, so without this they drift further from the
   * glyphs with every word. Measured once per span, on mount: the correction is a ratio of two
   * lengths that scale together, so it stays right at every zoom and never needs redoing.
   */
  function fitWidth(node: HTMLElement, targetPx: number) {
    const apply = (target: number) => {
      node.style.transform = '';
      const natural = node.getBoundingClientRect().width;
      const scaleX = horizontalScale(target, natural);
      // The rotation is already on the element; compose rather than overwrite it.
      const angle = node.dataset.angle ?? '0';
      node.style.transform = `rotate(${angle}rad) scaleX(${scaleX})`;
    };
    apply(targetPx);
    return { update: (next: number) => apply(next) };
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
>
  {#each runs as run, index (index)}
    <span
      class="pointer-events-auto absolute origin-top-left whitespace-pre text-transparent"
      data-angle={run.angle}
      style="left: {run.left * 100}%; top: {run.top * 100}%; font-size: {run.fontHeight}em;"
      use:fitWidth={run.width * pageWidth}>{run.text}</span
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
