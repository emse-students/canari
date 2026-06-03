<script lang="ts">
  import { ArrowUpRight } from '@lucide/svelte';
  import { navigateInAppFromHref } from '$lib/utils/appLinkNavigation';
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
  const linkTitle = $derived(title ?? (isInApp ? href : undefined));

  async function handleInAppClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    await navigateInAppFromHref(href);
  }
</script>

{#if isInApp}
  <a
    href={inAppPath}
    title={linkTitle}
    class="canari-app-link inline-flex items-center gap-0.5 font-medium text-amber-700 dark:text-amber-400 underline underline-offset-2 decoration-amber-500/50 hover:text-amber-600 dark:hover:text-amber-300 transition-colors {className}"
    onclick={handleInAppClick}
  >
    {#if children}
      {@render children()}
    {:else}
      {text ?? autoLabel ?? href}
    {/if}
    <ArrowUpRight size={12} class="shrink-0 opacity-70" aria-hidden="true" />
  </a>
{:else}
  <a
    {href}
    title={linkTitle}
    target="_blank"
    rel="noopener noreferrer"
    class="underline underline-offset-2 decoration-current hover:opacity-80 font-medium transition-opacity {className}"
    onclick={(e) => e.stopPropagation()}
  >
    {#if children}
      {@render children()}
    {:else}
      {text ?? href}
    {/if}
  </a>
{/if}
