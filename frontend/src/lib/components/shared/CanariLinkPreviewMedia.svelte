<script lang="ts">
  import type { CanariLinkPreview } from '$lib/utils/canariLinkPreview';

  interface Props {
    preview: CanariLinkPreview | null;
    loading?: boolean;
  }

  let { preview, loading = false }: Props = $props();
</script>

<!--
  Thumbnail of a link to Canari itself. Falls back to the site logo, centred, when the target has
  no image of its own: a per-kind glyph was both redundant - the card already spells the kind out
  in its category badge ("Publication", "Formulaire", "Association") - and unrecognisable, while
  the logo says at a glance that the link stays in the app.

  THE GRADIENT IS THE FALLBACK'S BACKDROP AND NOTHING ELSE'S (2026-09-20). It used to sit on the box
  unconditionally, where a real thumbnail hid all of it but a 1px seam: `inset-0` positions against
  the PADDING box, so the border leaves exactly one pixel of the box's own background showing all the
  way round - and this gradient is navy at one corner and burnt amber at the other, so on a logo with
  a white ground that seam reads as a drawn frame. Measured on the tile in isolation, both themes:
  *"pourquoi il y a un trait noir autour du logo ?"* (user). The scrim that darkened the bottom third
  went with it - it is what makes white text legible over a photo, and nothing is ever drawn over
  this tile, so all it did was grey the lower half of whatever logo it was given.
-->
<div
  class="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-black/5 sm:h-[4.5rem] sm:w-[4.5rem] dark:border-white/10"
>
  {#if loading}
    <div
      class="absolute inset-0 animate-pulse bg-black/15 dark:bg-white/10"
      aria-hidden="true"
    ></div>
  {:else if preview?.imageUrl}
    <img
      src={preview.imageUrl}
      alt=""
      class="absolute inset-0 h-full w-full object-cover"
      loading="lazy"
    />
  {:else}
    <div
      class="from-cn-ink absolute inset-0 bg-gradient-to-br via-[#1e2848] to-amber-700/70"
      aria-hidden="true"
    ></div>
    <img
      src="/favicon.svg"
      alt=""
      class="pointer-events-none relative z-[1] h-9 w-9 object-contain select-none sm:h-10 sm:w-10"
      aria-hidden="true"
    />
  {/if}
</div>
