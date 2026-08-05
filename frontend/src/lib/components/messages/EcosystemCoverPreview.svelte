<!--
  The cover-first preview card, used for the ecosystem pages whose whole point
  is an image (a MiGallery album today). Everything site-specific arrives as a
  prop: the chip label and the fallback title come from `ecosystemHosts.ts`, so
  adding a site is a registry entry rather than a second copy of this file.
-->
<script lang="ts">
  import { ExternalLink, Images } from '@lucide/svelte';
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
    /** When true, removes the top margin (card alone in the bubble). */
    standalone?: boolean;
  }

  let { url, preview, isLoading, siteLabel, fallbackTitle, standalone = false }: Props = $props();

  /** Fetched through Canari rather than from its host - see `previewImageProxy`. */
  const coverUrl = $derived(proxiedPreviewImageUrl(preview?.image));
</script>

<a
  href={url}
  target="_blank"
  rel="noopener noreferrer"
  class="group {standalone
    ? ''
    : 'mt-3'} flex items-stretch rounded-2xl border border-black/5 dark:border-white/10 bg-white/45 dark:bg-black/25 backdrop-blur-xl transition-all duration-300 hover:bg-white/70 dark:hover:bg-black/40 hover:border-amber-500/35 hover:shadow-md overflow-hidden"
>
  <!-- Cover thumbnail -->
  <div class="shrink-0 relative w-24 sm:w-28 overflow-hidden bg-black/8 dark:bg-white/8">
    {#if isLoading}
      <div class="absolute inset-0 animate-pulse bg-black/10 dark:bg-white/10"></div>
    {:else if coverUrl}
      <img
        src={coverUrl}
        alt=""
        class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
        loading="lazy"
      />
    {:else}
      <div class="absolute inset-0 flex items-center justify-center opacity-20">
        <Images size={28} strokeWidth={1.5} />
      </div>
    {/if}
  </div>

  <!-- Text metadata -->
  <div class="min-w-0 flex-1 px-3 py-2.5 flex flex-col justify-center gap-0.5">
    <span
      class="inline-flex self-start max-w-full items-center rounded-md bg-amber-500/12 dark:bg-amber-400/10 px-1.5 py-0.5 text-[0.6rem] tracking-wider font-bold text-amber-800 dark:text-amber-300 truncate"
    >
      {siteLabel}
    </span>

    {#if isLoading}
      <div class="h-3.5 w-3/4 rounded bg-black/8 dark:bg-white/8 animate-pulse mt-1"></div>
      <div class="h-2.5 w-1/2 rounded bg-black/6 dark:bg-white/6 animate-pulse mt-1"></div>
    {:else}
      <p
        class="text-sm font-bold text-text-main leading-snug line-clamp-2 group-hover:text-amber-700 dark:group-hover:text-amber-300 transition-colors duration-300"
      >
        {preview?.title || fallbackTitle}
      </p>
      {#if preview?.description}
        <p class="text-xs text-text-muted leading-snug line-clamp-1">
          {preview.description}
        </p>
      {/if}
    {/if}
  </div>

  <div
    class="shrink-0 self-center pr-3 opacity-35 text-text-muted group-hover:text-amber-600 dark:group-hover:text-amber-400 group-hover:opacity-100 transition-all duration-300 group-hover:translate-x-0.5"
  >
    <ExternalLink size={16} strokeWidth={2.25} />
  </div>
</a>
