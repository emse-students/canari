<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * THE ROUND GLASS CONTROL OF A CAMERA SCREEN - close, flip, flash, rotate, share, chat: the ONE
   * button of the camera and the live broadcaster, so a control added there cannot drift from its
   * siblings (the rotate button shipped as a 28px bordered chip beside 44px circles, 2026-11-11).
   *
   * A `.ui-icon-button` (44px on a touch screen) on a translucent black disc, hover and focus ring
   * included. It turns in place with the phone on a camera whose layout stays upright
   * (`.camera-glyph-turn`; still everywhere else). The caller draws the glyph at `size` 22-24 and `strokeWidth` 2.25-2.5, as the
   * siblings do. `data-*` markers of the call site land on the `<button>`.
   */
  interface Props {
    /** The accessible name and tooltip (Paraglide). */
    label: string;
    onclick: () => void;
    /** A toggle's state, announced as pressed / not pressed. */
    pressed?: boolean;
    disabled?: boolean;
    /** Extra classes of the button (a destructive tint). */
    class?: string;
    children: Snippet;
    [data: `data-${string}`]: unknown;
  }

  let {
    label,
    onclick,
    pressed,
    disabled = false,
    class: klass = '',
    children,
    ...markers
  }: Props = $props();
</script>

<button
  type="button"
  class="ui-icon-button camera-glyph-turn focus-visible:ring-accent-icon rounded-full bg-black/30 text-white outline-none hover:bg-black/50 focus-visible:ring-2 disabled:opacity-40 {klass}"
  aria-label={label}
  aria-pressed={pressed}
  title={label}
  {disabled}
  {onclick}
  {...markers}
>
  {@render children()}
</button>
