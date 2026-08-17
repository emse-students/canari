<!--
  The cover-first preview card, used for the ecosystem pages whose whole point
  is an image (a MiGallery album today). Everything site-specific arrives as a
  prop: the chip label and the fallback title come from `ecosystemHosts.ts`, so
  adding a site is a registry entry rather than a second copy of this file.

  The cover is shown as a square print sitting on a small stack of others,
  because that is what the link actually points at - an album, not a page with
  a picture on it. The stack fans out on hover; the photo itself never moves,
  so nothing about the image is hidden by the decoration.
-->
<script lang="ts">
  import { ArrowUpRight, Images } from '@lucide/svelte';
  import { proxiedPreviewImageUrl } from '$lib/utils/previewImageProxy';

  interface ExternalPreviewPayload {
    url: string;
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
  }

  interface Props {
    /** The page URL (used as the link href). */
    url: string;
    /** Preview data fetched from the link-preview endpoint. */
    preview: ExternalPreviewPayload | null;
    /** Whether the data is currently loading. */
    isLoading: boolean;
    /** The site's name, shown in the chip - never its bare hostname. */
    siteLabel: string;
    /** Title to show when the page declared none, already localized. */
    fallbackTitle: string;
    /**
     * A 1:1 cover the site serves for this page, when it has one. Preferred
     * over the payload's `og:image`, which is 1200x630 and would show as a
     * band of its middle in this square. Known from the URL alone, so it
     * paints before the preview fetch answers.
     */
    squareCoverUrl?: string | null;
    /** When true, removes the top margin (card alone in the bubble). */
    standalone?: boolean;
  }

  let {
    url,
    preview,
    isLoading,
    siteLabel,
    fallbackTitle,
    squareCoverUrl = null,
    standalone = false,
  }: Props = $props();

  /** Fetched through Canari rather than from its host - see `previewImageProxy`. */
  const coverUrl = $derived(proxiedPreviewImageUrl(squareCoverUrl ?? preview?.image));
</script>

<a
  href={url}
  target="_blank"
  rel="noopener noreferrer"
  class="group relative {standalone
    ? ''
    : 'mt-3'} flex items-center gap-3.5 p-3 pr-2.5 rounded-2xl border border-black/5 dark:border-white/10 bg-gradient-to-br from-amber-100/50 via-white/45 to-rose-100/40 dark:from-amber-400/10 dark:via-black/25 dark:to-fuchsia-400/10 backdrop-blur-xl transition-all duration-300 hover:border-amber-500/40 hover:shadow-lg hover:shadow-amber-500/10 dark:hover:shadow-amber-400/5"
>
  <!-- Cover, printed on a stack of the album's other photos -->
  <div class="relative shrink-0 w-24 sm:w-28 aspect-square">
    <div
      class="absolute inset-0 rounded-xl bg-white/70 dark:bg-white/15 rotate-6 scale-90 shadow-sm transition-transform duration-500 motion-safe:group-hover:rotate-[14deg]"
    ></div>
    <div
      class="absolute inset-0 rounded-xl bg-white/85 dark:bg-white/20 rotate-3 scale-95 shadow-sm transition-transform duration-500 motion-safe:group-hover:rotate-[7deg]"
    ></div>

    <div
      class="absolute inset-0 overflow-hidden rounded-xl ring-1 ring-black/10 dark:ring-white/15 bg-black/8 dark:bg-white/8 shadow-md transition-transform duration-500 motion-safe:group-hover:-rotate-2"
    >
      {#if coverUrl}
        <img
          src={coverUrl}
          alt=""
          class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
          loading="lazy"
        />
      {:else if isLoading}
        <div class="absolute inset-0 animate-pulse bg-black/10 dark:bg-white/10"></div>
      {:else}
        <div class="absolute inset-0 flex items-center justify-center opacity-20">
          <Images size={28} strokeWidth={1.5} />
        </div>
      {/if}
    </div>
  </div>

  <!-- Text metadata -->
  <div class="min-w-0 flex-1 flex flex-col justify-center gap-1">
    <span
      class="inline-flex self-start max-w-full items-center gap-1 rounded-md bg-amber-500/15 dark:bg-amber-400/12 px-1.5 py-0.5 text-[0.6rem] tracking-wider font-bold text-amber-800 dark:text-amber-300 truncate"
    >
      <Images size={11} strokeWidth={2.5} />
      {siteLabel}
    </span>

    {#if isLoading}
      <div class="h-3.5 w-3/4 rounded bg-black/8 dark:bg-white/8 animate-pulse"></div>
      <div class="h-2.5 w-1/2 rounded bg-black/6 dark:bg-white/6 animate-pulse"></div>
    {:else}
      <p
        class="text-sm font-bold text-text-main leading-snug line-clamp-2 group-hover:text-amber-700 dark:group-hover:text-amber-300 transition-colors duration-300"
      >
        {preview?.title || fallbackTitle}
      </p>
      {#if preview?.description}
        <p class="text-xs text-text-muted leading-snug line-clamp-2">
          {preview.description}
        </p>
      {/if}
    {/if}
  </div>

  <div
    class="shrink-0 self-start mt-0.5 rounded-full p-1.5 text-amber-700/60 dark:text-amber-300/60 bg-amber-500/0 group-hover:bg-amber-500/15 group-hover:text-amber-700 dark:group-hover:text-amber-300 transition-all duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
  >
    <ArrowUpRight size={16} strokeWidth={2.5} />
  </div>
</a>
