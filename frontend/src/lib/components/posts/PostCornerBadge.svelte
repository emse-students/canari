<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Props for the chip a post hangs off its own top-left corner.
   *
   * ## Why this is a component and not two spans
   *
   * It WAS two spans - "EPINGLE" written in `PostCard` and "NOUVEAU" written in the feed page -
   * identical but for an icon, and they diverged the moment one of them was touched: the amber glow
   * (`shadow-md shadow-amber-500/30`) was removed from the pinned chip in #639 because a
   * colour-tinted shadow was the only one of its kind on that surface and read as an accident, and
   * the new-post chip kept it. A reader saw the defect fixed on one post and alive on the next.
   *
   * The two are one thing - a label pinned to a card's corner - so they are one component, and the
   * next change to it cannot reach only half the feed.
   *
   * ## Why there is no glow
   *
   * A colour-tinted shadow says "this is lit", and on this surface every other chip, pill and card
   * says depth with a neutral shadow or with none. One element speaking a different visual language
   * reads as an accident, which is what it looked like on the phone - the halo bled onto the card
   * behind it. Amber-tinted shadows elsewhere in the app sit on amber BUTTONS, where the tint is the
   * button's own colour and the idiom is consistent; this is a 20 px chip overhanging something else.
   */
  interface Props {
    /** The chip's text, already localized by the caller. */
    label: string;
    /** Optional glyph rendered before the label, at the chip's scale. */
    icon?: Snippet;
  }

  let { label, icon }: Props = $props();
</script>

<!--
  `pointer-events-none` because the chip overhangs the card it names and must never eat a tap meant
  for the card's own header underneath it.
-->
<span
  class="text-cn-ink text-2xs pointer-events-none absolute -top-2 left-4 z-10 inline-flex items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 font-bold tracking-widest uppercase"
>
  {@render icon?.()}
  {label}
</span>
