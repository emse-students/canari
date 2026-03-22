<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    url: string;
  }

  let { url }: Props = $props();

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

  async function loadPreview(targetHref: string) {
    isLoading = true;
    try {
      const baseUrl = import.meta.env.VITE_DELIVERY_URL?.trim() || window.location.origin;
      const endpoint = `${baseUrl}/api/mls-api/link-preview?url=${encodeURIComponent(targetHref)}`;
      const res = await fetch(endpoint);
      if (!res.ok) return;
      preview = (await res.json()) as PreviewPayload;
    } catch {
      // Keep fallback card when preview API is unavailable.
    } finally {
      isLoading = false;
    }
  }

  onMount(() => {
    void loadPreview(parsed.href);
  });

  $effect(() => {
    const href = parsed.href;
    preview = null;
    void loadPreview(href);
  });
</script>

<a
  onclick={(e) => e.stopPropagation()}
  href={parsed.href}
  target="_blank"
  rel="noopener noreferrer"
  class="mt-2 flex items-center gap-3 p-3 rounded-2xl border border-cn-border bg-[color-mix(in_srgb,var(--cn-surface)_94%,transparent)] hover:bg-[var(--cn-surface)] transition-colors"
>
  {#if preview?.image}
    <img
      src={preview.image}
      alt="Apercu lien"
      class="w-12 h-12 rounded-lg object-cover bg-[var(--cn-surface)]"
    />
  {:else}
    <img
      src={faviconUrl}
      alt="Apercu lien"
      class="w-8 h-8 rounded-lg object-cover bg-[var(--cn-surface)]"
    />
  {/if}
  <div class="min-w-0 flex-1">
    <p class="text-xs uppercase tracking-wide text-text-muted truncate">
      {preview?.siteName || parsed.host}
    </p>
    <p class="text-sm font-medium text-cn-dark truncate">
      {preview?.title || parsed.path || parsed.href}
    </p>
    {#if preview?.description}
      <p class="text-xs text-text-muted truncate">{preview.description}</p>
    {:else if isLoading}
      <p class="text-xs text-text-muted">Chargement de l'apercu...</p>
    {/if}
  </div>
  <span class="text-xs text-text-muted font-medium">Ouvrir</span>
</a>
