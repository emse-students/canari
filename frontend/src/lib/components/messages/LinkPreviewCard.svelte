<script lang="ts">
  import { ArrowUpRight, ExternalLink } from '@lucide/svelte';
  import { navigateInAppFromHref } from '$lib/utils/appLinkNavigation';
  import { inAppPathFromHref, isInAppHref, publicAppLinkLabel } from '$lib/utils/publicAppUrl';

  interface Props {
    /** The URL whose Open Graph / meta preview should be fetched and displayed. */
    url: string;
  }

  let { url }: Props = $props();

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

  const inAppLabel = $derived(publicAppLinkLabel(url));
  const inAppPath = $derived(inAppPathFromHref(url));

  const faviconUrl = $derived(
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(parsed.host)}&sz=64`
  );

  interface PreviewPayload {
    url: string;
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
  }

  let preview = $state<PreviewPayload | null>(null);
  let isLoading = $state(false);

  $effect(() => {
    if (isInApp) {
      preview = null;
      isLoading = false;
      return;
    }

    const targetHref = parsed.href;
    let isCancelled = false;

    async function loadPreview() {
      isLoading = true;
      try {
        const baseUrl = import.meta.env.VITE_DELIVERY_URL?.trim() || window.location.origin;
        const endpoint = `${baseUrl}/api/mls/link-preview?url=${encodeURIComponent(targetHref)}`;
        const res = await fetch(endpoint);

        if (!res.ok) return;

        const data = (await res.json()) as PreviewPayload;
        if (!isCancelled) {
          preview = data;
        }
      } catch {
        // Fallback: favicon + host only
      } finally {
        if (!isCancelled) {
          isLoading = false;
        }
      }
    }

    preview = null;
    loadPreview();

    return () => {
      isCancelled = true;
    };
  });

  async function handleClick(e: MouseEvent) {
    e.stopPropagation();
    if (!isInApp) return;
    e.preventDefault();
    await navigateInAppFromHref(url);
  }
</script>

<a
  onclick={handleClick}
  href={isInApp ? (inAppPath ?? '#') : parsed.href}
  target={isInApp ? undefined : '_blank'}
  rel={isInApp ? undefined : 'noopener noreferrer'}
  class="group mt-3 flex items-center gap-4 p-3 sm:p-4 rounded-2xl border border-black/5 dark:border-white/10 bg-white/40 dark:bg-black/20 backdrop-blur-xl transition-all duration-300 hover:bg-white/60 dark:hover:bg-black/40 hover:border-amber-500/30 hover:shadow-md overflow-hidden {isInApp
    ? 'ring-1 ring-amber-500/15'
    : ''}"
>
  <div
    class="shrink-0 relative overflow-hidden rounded-xl border border-black/5 dark:border-white/5 bg-black/5 dark:bg-white/5 flex items-center justify-center transition-all duration-300
    {preview?.image ? 'w-16 h-16 sm:w-20 sm:h-20' : 'w-12 h-12'}"
  >
    {#if isInApp}
      <span
        class="text-lg font-extrabold text-amber-600 dark:text-amber-400 select-none"
        aria-hidden="true">C</span
      >
    {:else if isLoading}
      <div class="absolute inset-0 bg-black/10 dark:bg-white/10 animate-pulse"></div>
    {:else if preview?.image}
      <img
        src={preview.image}
        alt="Aperçu du lien"
        class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
      />
    {:else}
      <img
        src={faviconUrl}
        alt="Favicon du site"
        class="w-6 h-6 object-contain opacity-70 group-hover:opacity-100 transition-opacity duration-300"
      />
    {/if}
  </div>

  <div class="min-w-0 flex-1 py-1">
    <p
      class="text-[10px] sm:text-xs uppercase tracking-wider font-bold text-text-muted mb-1 truncate"
    >
      {isInApp ? 'Canari' : preview?.siteName || parsed.host}
    </p>

    <p
      class="text-sm font-bold text-text-main leading-snug truncate group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors duration-300"
    >
      {isInApp ? inAppLabel : preview?.title || parsed.path || parsed.href}
    </p>

    {#if isInApp}
      <p class="text-xs text-text-muted mt-1 truncate opacity-80">Ouvrir dans l'application</p>
    {:else if isLoading}
      <div class="h-3 w-2/3 bg-black/5 dark:bg-white/10 rounded animate-pulse mt-2.5"></div>
    {:else if preview?.description}
      <p class="text-xs text-text-muted mt-1 truncate opacity-80">{preview.description}</p>
    {/if}
  </div>

  <div
    class="shrink-0 pl-1 pr-2 opacity-40 text-text-muted group-hover:text-amber-500 group-hover:opacity-100 transition-all duration-300 group-hover:translate-x-1"
  >
    {#if isInApp}
      <ArrowUpRight size={20} strokeWidth={2.5} />
    {:else}
      <ExternalLink size={20} strokeWidth={2.5} />
    {/if}
  </div>
</a>
