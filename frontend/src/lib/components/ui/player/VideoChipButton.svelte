<script lang="ts">
  import type { Snippet } from 'svelte';
  import { videoGlass } from '$lib/utils/videoGlass';

  /**
   * A ROUND CONTROL ON A PLAYING VIDEO - the speaker, the expand chip, the lightbox bar's buttons
   * (owner, 2026-11-09). The kit's one button, so every surface's speaker is the same object.
   *
   * THE TARGET IS 44px, THE DRAWING IS SMALLER: the `<button>` is a `.ui-icon-button` (44px on a touch
   * screen, 38px under a pointer) and transparent; the visible chip is the round `glass-video` span
   * inside it, 28px - Instagram's speaker measured ~24 dp on the Mi 9T - so it does not cover the
   * picture and still cannot be missed.
   *
   * `glass` off draws the glyph alone (no chip): inside the lightbox's glass bar, where a second
   * blur would be stacked on the first (design-reference section 3: never two).
   *
   * Every press stops at the button: the player's tap (`videoGestures`) and the viewer's swipe never
   * see it, which is what `data-video-controls` says to both.
   */
  interface Props {
    /** The accessible name (Paraglide). */
    label: string;
    onclick: () => void;
    /** A toggle's state (the speaker), announced as pressed / not pressed. */
    pressed?: boolean;
    /** Drawn as its own glass chip; off inside a glass bar. Default on. */
    glass?: boolean;
    disabled?: boolean;
    /** Classes of the button - where it sits on the player. */
    class?: string;
    /** Out of the tab order when the player's keyboard map already covers it. */
    tabindex?: number;
    /** A tooltip under a pointer (the reel rail's buttons all carry one). */
    title?: string;
    children: Snippet;
    /** `data-*` markers of the call site (`data-reel-rail-sound`), set on the button. */
    [data: `data-${string}`]: unknown;
  }

  let {
    label,
    onclick,
    pressed,
    glass = true,
    disabled = false,
    class: klass = '',
    tabindex,
    title,
    children,
    ...markers
  }: Props = $props();
</script>

<button
  type="button"
  class="ui-icon-button group/chip rounded-full text-white outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1 focus-visible:ring-offset-black disabled:opacity-50 {klass}"
  aria-label={label}
  aria-pressed={pressed}
  {disabled}
  {tabindex}
  {title}
  {...markers}
  data-video-controls
  onpointerdown={(e) => e.stopPropagation()}
  onclick={(e) => {
    e.stopPropagation();
    onclick();
  }}
>
  <span
    class="pointer-events-none inline-flex items-center justify-center rounded-full transition-transform duration-150 group-active/chip:scale-90 motion-reduce:transition-none {glass
      ? 'glass-video h-7 w-7'
      : ''}"
    data-glass={glass ? videoGlass() : undefined}
  >
    {@render children()}
  </span>
</button>
