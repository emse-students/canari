<script lang="ts">
  import { ArrowUpRight, ExternalLink } from '@lucide/svelte';
  import CanariLinkPreviewMedia from '$lib/components/shared/CanariLinkPreviewMedia.svelte';
  import MiGalleryLinkPreview from '$lib/components/messages/MiGalleryLinkPreview.svelte';
  import { navigateInAppFromHref } from '$lib/utils/appLinkNavigation';
  import { fetchCanariLinkPreview, type CanariLinkPreview } from '$lib/utils/canariLinkPreview';
  import { inAppPathFromHref, isInAppHref, publicAppLinkLabel } from '$lib/utils/publicAppUrl';

  interface Props {
    /** The URL whose Open Graph / meta preview should be fetched and displayed. */
    url: string;
    /** When true, removes the top margin (card is the only element in the bubble). */
    standalone?: boolean;
  }

  let { url, standalone = false }: Props = $props();

  const isInApp = $derived(isInAppHref(url));

  const parsed = $derived.by(() => {
    try {
      const u = new URL(url);
      return {
        host: u.hostname.replace(/^www\./, ''),
        href: u.href,
        path: u.pathname && u.pathname !== '/' ? u.pathname : '',
      };
    } catch {
      return {
        host: url,
        href: url,
        path: '',
      };
    }
  });

  /** Vrai si le lien pointe vers un album MiGallery (gallery.mitv.fr/albums/[id]). */
  const isMiGalleryAlbum = $derived(
    parsed.host === 'gallery.mitv.fr' && /^\/albums\/[0-9a-f-]+\/?$/i.test(parsed.path)
  );

  const fallbackInAppLabel = $derived(publicAppLinkLabel(url));
  const inAppPath = $derived(inAppPathFromHref(url));

  const faviconUrl = $derived(
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.host)}&sz=64`
  );

  interface ExternalPreviewPayload {
    url: string;
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
  }

  let canariPreview = $state<CanariLinkPreview | null>(null);
  let externalPreview = $state<ExternalPreviewPayload | null>(null);
  let isLoading = $state(false);

  $effect(() => {
    const targetUrl = url;
    let cancelled = false;

    async function load() {
      isLoading = true;
      canariPreview = null;
      externalPreview = null;

      try {
        if (isInAppHref(targetUrl)) {
          const data = await fetchCanariLinkPreview(targetUrl);
          if (!cancelled) canariPreview = data;
          return;
        }

        const baseUrl = import.meta.env.VITE_DELIVERY_URL?.trim() || window.location.origin;
        const endpoint = `${baseUrl}/api/mls/link-preview?url=${encodeURIComponent(parsed.href)}`;
        const res = await fetch(endpoint);
        if (res.ok) {
          const data = (await res.json()) as ExternalPreviewPayload;
          if (!cancelled) externalPreview = data;
        }
      } catch {
        // Fallback UI only
      } finally {
        if (!cancelled) isLoading = false;
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  });

  const cardTitle = $derived(
    isInApp
      ? (canariPreview?.title ?? fallbackInAppLabel ?? 'Canari')
      : externalPreview?.title || parsed.path || parsed.href
  );

  const cardCategory = $derived(
    isInApp ? (canariPreview?.categoryLabel ?? 'Canari') : externalPreview?.siteName || parsed.host
  );

  const cardSubtitle = $derived(isInApp ? canariPreview?.subtitle : externalPreview?.description);

  async function handleClick(e: MouseEvent) {
    e.stopPropagation();
    if (!isInApp) return;
    e.preventDefault();
    await navigateInAppFromHref(url);
  }
</script>

{#if isMiGalleryAlbum}
  <MiGalleryLinkPreview url={parsed.href} preview={externalPreview} {isLoading} {standalone} />
{:else}
  <a
    onclick={handleClick}
    href={isInApp ? (inAppPath ?? '#') : parsed.href}
    target={isInApp ? undefined : '_blank'}
    rel={isInApp ? undefined : 'noopener noreferrer'}
    class="group {standalone
      ? ''
      : 'mt-3'} flex items-stretch gap-3.5 p-3 sm:p-4 rounded-2xl border border-black/5 dark:border-white/10 bg-white/45 dark:bg-black/25 backdrop-blur-xl transition-all duration-300 hover:bg-white/70 dark:hover:bg-black/40 hover:border-amber-500/35 hover:shadow-md overflow-hidden {isInApp
      ? 'ring-1 ring-amber-500/12'
      : ''}"
  >
    {#if isInApp}
      <CanariLinkPreviewMedia preview={canariPreview} loading={isLoading} />
    {:else}
      <div
        class="shrink-0 relative overflow-hidden rounded-xl border border-black/5 dark:border-white/5 bg-black/5 dark:bg-white/5 flex items-center justify-center transition-all duration-300
      {externalPreview?.image ? 'w-16 h-16 sm:w-[4.5rem] sm:h-[4.5rem]' : 'w-12 h-12'}"
      >
        {#if isLoading}
          <div class="absolute inset-0 bg-black/10 dark:bg-white/10 animate-pulse"></div>
        {:else if externalPreview?.image}
          <img
            src={externalPreview.image}
            alt=""
            class="w-full h-full object-cover"
            loading="lazy"
          />
        {:else}
          <img
            src={faviconUrl}
            alt=""
            class="w-6 h-6 object-contain opacity-70 group-hover:opacity-100 transition-opacity duration-300"
          />
        {/if}
      </div>
    {/if}

    <div class="min-w-0 flex-1 py-0.5 flex flex-col justify-center gap-0.5">
      <span
        class="inline-flex self-start max-w-full items-center rounded-md bg-amber-500/12 dark:bg-amber-400/10 px-2 py-0.5 text-[0.65rem] sm:text-[0.68rem] uppercase tracking-wider font-bold text-amber-800 dark:text-amber-300 truncate"
      >
        {cardCategory}
      </span>

      <p
        class="text-sm sm:text-[0.95rem] font-bold text-text-main leading-snug line-clamp-2 group-hover:text-amber-700 dark:group-hover:text-amber-300 transition-colors duration-300"
      >
        {cardTitle}
      </p>

      {#if isLoading && isInApp}
        <div
          class="h-3 w-4/5 max-w-[14rem] bg-black/6 dark:bg-white/8 rounded animate-pulse mt-1"
        ></div>
      {:else if cardSubtitle}
        <p class="text-xs text-text-muted leading-snug line-clamp-2 opacity-90">{cardSubtitle}</p>
      {/if}
    </div>

    <div
      class="shrink-0 self-center pl-0.5 pr-1 opacity-35 text-text-muted group-hover:text-amber-600 dark:group-hover:text-amber-400 group-hover:opacity-100 transition-all duration-300 group-hover:translate-x-0.5"
    >
      {#if isInApp}
        <ArrowUpRight size={20} strokeWidth={2.25} />
      {:else}
        <ExternalLink size={20} strokeWidth={2.25} />
      {/if}
    </div>
  </a>
{/if}
