<script lang="ts" module>
  let nextId = 0;
</script>

<script lang="ts">
  import { glassGlyphPath, type GlassGlyphKind } from '$lib/utils/videoGlassGlyph';
  import { videoGlass } from '$lib/utils/videoGlass';

  /**
   * THE PLAY / PAUSE POP: A GLYPH THAT IS ITSELF THE (FAKE) GLASS - NO DISC BEHIND IT (owner,
   * 2026-11-09: *"J'aurais juste fait le triangle en liquid glass"*; 2026-11-15: no blur, anywhere).
   * Three layers in one box:
   *
   * 1. a soft shadow - the same shape, blurred, a sibling underneath;
   * 2. the fake glass - `.glass-video-shape` clipped to the shape: the translucent dark fill and the
   *    sheen exist only inside the triangle (or the two bars), so a white frame and a black one both
   *    leave the white glyph legible. NO backdrop filter (the Mi 9T measured it at 98-99 % janky);
   * 3. the rim - the same path stroked in a light that fades from the top-left edge, the specular
   *    line a disc got from an inset shadow (a clipped element cannot carry its own border).
   *
   * It is not a button; it is only drawn as the gesture's pop (`VideoFeedbackGlyph`) - a RESTING
   * triangle is the flat `VideoRestingPlay`. Reduced transparency and more contrast make the fill
   * near-solid through the tokens.
   */
  interface Props {
    kind: GlassGlyphKind;
    /** The side of the square box, in px. */
    size: number;
    class?: string;
  }

  let { kind, size, class: className = '' }: Props = $props();

  const path = $derived(glassGlyphPath(kind, size));
  const rimId = `video-glyph-rim-${nextId++}`;
</script>

<span
  class="pointer-events-none relative block shrink-0 {className}"
  style="width: {size}px; height: {size}px"
  aria-hidden="true"
  data-video-glass-glyph={kind}
>
  <svg
    class="absolute inset-0 overflow-visible"
    width={size}
    height={size}
    viewBox="0 0 {size} {size}"
    style="filter: blur(5px); transform: translateY(2px)"
  >
    <path d={path} class="fill-black/40" />
  </svg>
  <span
    class="glass-video-shape absolute inset-0"
    style="clip-path: path('{path}'); -webkit-clip-path: path('{path}')"
    data-glass={videoGlass()}
  ></span>
  <svg class="absolute inset-0 text-white" width={size} height={size} viewBox="0 0 {size} {size}">
    <defs>
      <linearGradient id={rimId} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="currentColor" stop-opacity="0.7" />
        <stop offset="0.55" stop-color="currentColor" stop-opacity="0.16" />
        <stop offset="1" stop-color="currentColor" stop-opacity="0.05" />
      </linearGradient>
    </defs>
    <path d={path} fill="none" stroke="url(#{rimId})" stroke-width="1.25" stroke-linejoin="round" />
  </svg>
</span>
