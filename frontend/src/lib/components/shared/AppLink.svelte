<script lang="ts">
  import { ArrowUpRight } from '@lucide/svelte';
  import { navigateInAppFromHref } from '$lib/utils/appLinkNavigation';
  import { fetchCanariLinkPreview, getCachedCanariLinkPreview } from '$lib/utils/canariLinkPreview';
  import { openExternal } from '$lib/utils/openExternal';
  import { inAppPathFromHref, publicAppLinkLabel } from '$lib/utils/publicAppUrl';
  import type { Snippet } from 'svelte';

  interface Props {
    /** Target URL (absolute public link or in-app path such as `/posts/abc`). */
    href: string;
    /** Optional visible text; defaults to a short label for Canari routes or the raw URL. */
    text?: string;
    title?: string;
    class?: string;
    children?: Snippet;
  }

  let { href, text, title, class: className = '', children }: Props = $props();

  const inAppPath = $derived(inAppPathFromHref(href));
  const isInApp = $derived(inAppPath !== null);
  const autoLabel = $derived(publicAppLinkLabel(href));
  let richLabel = $state<string | null>(null);
  const displayText = $derived(
    text ?? (richLabel && isInApp ? richLabel : null) ?? autoLabel ?? href
  );
  const linkTitle = $derived(title ?? href);

  $effect(() => {
    if (!isInApp) {
      richLabel = null;
      return;
    }
    const h = href;
    const cached = getCachedCanariLinkPreview(h);
    if (cached?.title) {
      richLabel = cached.title;
      return;
    }
    let cancelled = false;
    void fetchCanariLinkPreview(h).then((p) => {
      if (!cancelled && p?.title) richLabel = p.title;
    });
    return () => {
      cancelled = true;
    };
  });

  async function handleInAppClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    await navigateInAppFromHref(href);
  }

  /**
   * `openExternal` carries its own Safe Browsing gate (WP-SAFELINK-1). Only intercepts a plain
   * left-click - a modified click (ctrl/cmd/middle-click/shift, used to open in a new tab or
   * window explicitly) is left to the browser's own native handling, since an async confirm
   * cannot honor those afterward anyway.
   */
  async function handleExternalClick(e: MouseEvent) {
    e.stopPropagation();
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    await openExternal(href);
  }
</script>

{#if isInApp}
  <a
    href={inAppPath}
    title={linkTitle}
    class="canari-app-link inline-flex items-center gap-0.5 font-medium text-amber-700 underline decoration-amber-500/50 underline-offset-2 transition-colors hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300 {className}"
    onclick={handleInAppClick}
  >
    {#if children}
      {@render children()}
    {:else}
      {displayText}
    {/if}
    <ArrowUpRight size={12} class="shrink-0 opacity-70" aria-hidden="true" />
  </a>
{:else}
  <a
    {href}
    title={linkTitle}
    target="_blank"
    rel="noopener noreferrer"
    class="font-medium underline decoration-current underline-offset-2 transition-opacity hover:opacity-80 {className}"
    onclick={handleExternalClick}
  >
    {#if children}
      {@render children()}
    {:else}
      {text ?? href}
    {/if}
  </a>
{/if}
