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
-->
<div
  class="shrink-0 relative overflow-hidden rounded-xl border border-black/5 dark:border-white/10 flex items-center justify-center w-16 h-16 sm:w-[4.5rem] sm:h-[4.5rem] bg-gradient-to-br from-cn-ink via-[#1e2848] to-amber-700/70"
>
  {#if loading}
    <div
      class="absolute inset-0 bg-black/15 dark:bg-white/10 animate-pulse"
      aria-hidden="true"
    ></div>
  {:else if preview?.imageUrl}
    <img
      src={preview.imageUrl}
      alt=""
      class="absolute inset-0 w-full h-full object-cover"
      loading="lazy"
    />
    <div
      class="absolute inset-0 bg-gradient-to-t from-black/35 via-transparent to-transparent"
      aria-hidden="true"
    ></div>
  {:else}
    <img
      src="/favicon.svg"
      alt=""
      class="relative z-[1] w-9 h-9 sm:w-10 sm:h-10 object-contain pointer-events-none select-none"
      aria-hidden="true"
    />
  {/if}
</div>
