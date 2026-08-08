<script lang="ts">
  import { ArrowUpRight, ExternalLink, Globe } from '@lucide/svelte';
  import CanariLinkPreviewMedia from '$lib/components/shared/CanariLinkPreviewMedia.svelte';
  import EcosystemCoverPreview from '$lib/components/messages/EcosystemCoverPreview.svelte';
  import { navigateInAppFromHref } from '$lib/utils/appLinkNavigation';
  import { fetchCanariLinkPreview, type CanariLinkPreview } from '$lib/utils/canariLinkPreview';
  import { CANARI_BADGE_LABEL } from '$lib/utils/canariLinkPreviewFormat';
  import { confirmUnsafeLinkIfNeeded } from '$lib/utils/checkLinkSafety';
  import { ecosystemCoverCardFor, ecosystemSiteFor } from '$lib/utils/ecosystemHosts';
  import { faviconCandidates } from '$lib/utils/faviconCandidates';
  import { proxiedPreviewImageUrl } from '$lib/utils/previewImageProxy';
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

  /**
   * The site behind an external link, when it is one of ours. Both the chip
   * label and the choice of card come from the registry rather than from a
   * hostname compared in place, so a fifth site is one entry there.
   */
  const ecosystemSite = $derived(ecosystemSiteFor(parsed.host));
  const coverCard = $derived(ecosystemCoverCardFor(parsed.host, parsed.path));

  const fallbackInAppLabel = $derived(publicAppLinkLabel(url));
  const inAppPath = $derived(inAppPathFromHref(url));

  interface ExternalPreviewPayload {
    url: string;
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
    /** The site's own icon, resolved server-side from its `<link rel="icon">`. */
    icon?: string;
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

  /**
   * The amber chip. In-app it names the KIND of content (Publication, Association...),
   * falling back to the brand for a plain route; for an external link it is the HOST,
   * never `siteName`. The one rule behind both: a great many sites set `og:site_name`
   * to the page title, and a Canari route had nothing but its own label to show, so
   * either way the chip and the title below it printed the same sentence twice. What
   * belongs here is the thing the title does not already say - where the link goes.
   *
   * A site of our own ecosystem shows its name instead of its hostname: the rule is
   * unchanged, the reader simply already knows the destination by that name, and
   * `sky.mitv.fr` names it to nobody but whoever deployed it.
   */
  const cardCategory = $derived(
    isInApp
      ? (canariPreview?.categoryLabel ?? CANARI_BADGE_LABEL)
      : (ecosystemSite?.label ?? parsed.host)
  );

  const cardSubtitle = $derived(isInApp ? canariPreview?.subtitle : externalPreview?.description);

  /**
   * The site's own icon, as an ordered list of things to try. The preview endpoint
   * resolves the declared one from the page it already downloaded; the conventional
   * paths follow it, in any format, so a single 404 does not end the search.
   * Deliberately NOT a third-party icon service: those only know hosts they have
   * crawled and answer a generic globe for anything private or unindexed - which is
   * why self-hosted sites showed a placeholder - and asking one would hand every
   * browsed hostname to a third party from inside an end-to-end encrypted
   * conversation.
   *
   * Every candidate goes through Canari's image proxy, which is what keeps that
   * last sentence true for the conventional paths too - they are derived here,
   * so nothing server-side would otherwise have rewritten them.
   */
  const faviconChain = $derived(
    faviconCandidates(parsed.href, externalPreview?.icon).map(proxiedPreviewImageUrl)
  );

  /** The Open Graph image, likewise fetched through the proxy rather than from its host. */
  const previewImageUrl = $derived(proxiedPreviewImageUrl(externalPreview?.image));

  /** Resolves once we know whether `src` decodes as an image. Never rejects. */
  function loadsAsImage(src: string): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve(probe.naturalWidth > 0);
      probe.onerror = () => resolve(false);
      probe.src = src;
    });
  }

  /**
   * The first candidate that actually decodes, or '' while none has been proven.
   *
   * The chain is walked with off-screen probes rather than by cascading the
   * displayed `<img>` through its own `onerror`: that `<img>` is a single element
   * reused across every candidate, so a failure event already queued for one src
   * still fires after the next has been assigned, and advancing on it skips the
   * candidate now on screen. That is what made an icon appear and then be
   * replaced by the globe a moment later - the chain is rebuilt when the preview
   * payload arrives with the site's declared icon, and the stale error from the
   * conventional path tried meanwhile walked straight past it. A probe owns its
   * own element, so an answer can only ever be about the URL that was asked.
   */
  let faviconUrl = $state('');
  /** False while candidates are still being probed: the globe waits for a verdict. */
  let faviconSearchDone = $state(false);
  $effect(() => {
    const chain = faviconChain;
    let cancelled = false;
    faviconUrl = '';
    faviconSearchDone = false;

    void (async () => {
      for (const candidate of chain) {
        const ok = await loadsAsImage(candidate);
        if (cancelled) return;
        if (ok) {
          faviconUrl = candidate;
          faviconSearchDone = true;
          return;
        }
      }
      faviconSearchDone = true;
    })();

    return () => {
      cancelled = true;
    };
  });

  async function handleClick(e: MouseEvent) {
    e.stopPropagation();
    if (isInApp) {
      e.preventDefault();
      await navigateInAppFromHref(url);
      return;
    }

    // WP-SAFELINK-1: same gate as AppLink's external branch. Only a plain left-click is
    // intercepted - a modified click (new tab/window) goes through the browser's own handling.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const proceed = await confirmUnsafeLinkIfNeeded(parsed.href);
    if (proceed) {
      window.open(parsed.href, '_blank', 'noopener,noreferrer');
    }
  }
</script>

{#if coverCard}
  <EcosystemCoverPreview
    url={parsed.href}
    preview={externalPreview}
    {isLoading}
    siteLabel={ecosystemSite?.label ?? parsed.host}
    fallbackTitle={coverCard.fallbackTitle()}
    {standalone}
  />
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
      {previewImageUrl ? 'w-16 h-16 sm:w-[4.5rem] sm:h-[4.5rem]' : 'w-12 h-12'}"
      >
        {#if isLoading}
          <div class="absolute inset-0 bg-black/10 dark:bg-white/10 animate-pulse"></div>
        {:else if previewImageUrl}
          <img src={previewImageUrl} alt="" class="w-full h-full object-cover" loading="lazy" />
        {:else if faviconUrl}
          <!-- No Open Graph image: the site's own favicon stands in for its logo.
               Already proven loadable by the probe above, so it needs no onerror. -->
          <img
            src={faviconUrl}
            alt=""
            class="w-8 h-8 object-contain opacity-70 group-hover:opacity-100 transition-opacity duration-300"
          />
        {:else if faviconSearchDone}
          <Globe
            size={20}
            strokeWidth={2}
            class="text-text-muted opacity-50 group-hover:opacity-80 transition-opacity duration-300"
          />
        {/if}
      </div>
    {/if}

    <div class="min-w-0 flex-1 py-0.5 flex flex-col justify-center gap-0.5">
      <span
        class="inline-flex self-start max-w-full items-center rounded-md bg-amber-500/12 dark:bg-amber-400/10 px-2 py-0.5 text-[0.65rem] sm:text-[0.68rem] tracking-wider font-bold text-amber-800 dark:text-amber-300 truncate {isInApp
          ? 'uppercase'
          : 'normal-case'}"
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
