<!--
  The cover-first preview card, used for the ecosystem pages whose whole point
  is an image (a MiGallery album today). Everything site-specific arrives as a
  prop: the chip label and the fallback title come from `ecosystemHosts.ts`, so
  adding a site is a registry entry rather than a second copy of this file.

  The cover is shown as a square print sitting on a small stack of others,
  because that is what the link actually points at - an album, not a page with
  a picture on it. The stack fans out on hover; the photo itself never moves,
  so nothing about the image is hidden by the decoration.

  The same cover, blurred past recognition, also tints the card: a link to a
  sunset arrives orange and a link to a night out arrives blue, which is a
  better hint at what is behind it than any fixed palette. It sits under an
  opaque scrim so the text keeps its contrast whatever the photo does, and the
  card falls back to the warm ecosystem gradient until the image loads.
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
  class="group relative isolate overflow-hidden {standalone
    ? ''
    : 'mt-3'} flex items-center gap-3.5 rounded-2xl border border-black/5 bg-gradient-to-br from-amber-100/50 via-white/45 to-rose-100/40 p-3 pr-2.5 backdrop-blur-xl transition-all duration-300 hover:border-amber-500/40 hover:shadow-lg hover:shadow-amber-500/10 dark:border-white/10 dark:from-amber-400/10 dark:via-black/25 dark:to-fuchsia-400/10 dark:hover:shadow-amber-400/5"
>
  <!-- The cover's own colours, blurred out of legibility, under a scrim -->
  {#if coverUrl}
    <img
      src={coverUrl}
      alt=""
      aria-hidden="true"
      loading="lazy"
      class="absolute inset-0 -z-10 h-full w-full scale-150 object-cover opacity-45 blur-2xl saturate-150 transition-opacity duration-500 group-hover:opacity-60 dark:opacity-35 dark:group-hover:opacity-50"
    />
    <div class="absolute inset-0 -z-10 bg-white/55 dark:bg-black/55" aria-hidden="true"></div>
  {/if}

  <!-- Cover, printed on a stack of the album's other photos -->
  <div class="relative aspect-square w-24 shrink-0 sm:w-28">
    <div
      class="absolute inset-0 scale-90 rotate-6 rounded-xl bg-white/70 shadow-sm transition-transform duration-500 motion-safe:group-hover:rotate-[14deg] dark:bg-white/15"
    ></div>
    <div
      class="absolute inset-0 scale-95 rotate-3 rounded-xl bg-white/85 shadow-sm transition-transform duration-500 motion-safe:group-hover:rotate-[7deg] dark:bg-white/20"
    ></div>

    <div
      class="absolute inset-0 overflow-hidden rounded-xl bg-black/8 shadow-md ring-1 ring-black/10 transition-transform duration-500 motion-safe:group-hover:-rotate-2 dark:bg-white/8 dark:ring-white/15"
    >
      {#if coverUrl}
        <img
          src={coverUrl}
          alt=""
          class="h-full w-full object-cover transition-transform duration-700 group-hover:scale-110"
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
  <div class="flex min-w-0 flex-1 flex-col justify-center gap-1">
    <span
      class="inline-flex max-w-full items-center gap-1 self-start truncate rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[0.6rem] font-bold tracking-wider text-amber-800 dark:bg-amber-400/12 dark:text-amber-300"
    >
      <Images size={11} strokeWidth={2.5} />
      {siteLabel}
    </span>

    {#if isLoading}
      <div class="h-3.5 w-3/4 animate-pulse rounded bg-black/8 dark:bg-white/8"></div>
      <div class="h-2.5 w-1/2 animate-pulse rounded bg-black/6 dark:bg-white/6"></div>
    {:else}
      <p
        class="text-text-main line-clamp-2 text-sm leading-snug font-bold transition-colors duration-300 group-hover:text-amber-700 dark:group-hover:text-amber-300"
      >
        {preview?.title || fallbackTitle}
      </p>
      {#if preview?.description}
        <p class="text-text-muted line-clamp-2 text-xs leading-snug">
          {preview.description}
        </p>
      {/if}
    {/if}
  </div>

  <div
    class="mt-0.5 shrink-0 self-start rounded-full bg-amber-500/0 p-1.5 text-amber-700/60 transition-all duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:bg-amber-500/15 group-hover:text-amber-700 dark:text-amber-300/60 dark:group-hover:text-amber-300"
  >
    <ArrowUpRight size={16} strokeWidth={2.5} />
  </div>
</a>
