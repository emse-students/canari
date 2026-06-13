<script lang="ts">
  import { X, Search } from '@lucide/svelte';
  import { fade, fly } from 'svelte/transition';

  interface Props {
    open: boolean;
    onClose: () => void;
    /** Called with the chosen GIF's direct .gif URL (rendered inline by isGifUrl). */
    onSelect: (url: string) => void;
  }

  let { open, onClose, onSelect }: Props = $props();

  // KLIPY: lifetime-free GIF API (Tenor stopped issuing keys; Giphy's free tier is 100/h).
  // Key is optional - the composer hides the GIF button when absent, so this stays graceful.
  const KLIPY_KEY = (import.meta.env as Record<string, string | undefined>).VITE_KLIPY_KEY;

  /** Stable anonymous id for KLIPY session/analytics (their API expects a customer_id). */
  function customerId(): string {
    try {
      let id = localStorage.getItem('klipy_cid');
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem('klipy_cid', id);
      }
      return id;
    } catch {
      return 'anonymous';
    }
  }

  interface GifItem {
    id: string;
    preview: string;
    full: string;
  }

  let query = $state('');
  let results = $state<GifItem[]>([]);
  let loading = $state(false);
  let error = $state('');
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let fetchSeq = 0;

  function mapData(items: unknown[]): GifItem[] {
    return (items ?? [])
      .map((raw) => {
        const g = raw as {
          id?: string | number;
          file?: Record<string, { gif?: { url?: string } }>;
        };
        const file = g.file ?? {};
        return {
          id: String(g.id ?? ''),
          // Small variant for the grid, medium for sending (both are real .gif URLs).
          preview: file.sm?.gif?.url ?? file.xs?.gif?.url ?? file.md?.gif?.url ?? '',
          full: file.md?.gif?.url ?? file.hd?.gif?.url ?? file.sm?.gif?.url ?? '',
        };
      })
      .filter((g) => g.id && g.preview && g.full);
  }

  async function fetchGifs(q: string) {
    if (!KLIPY_KEY) return;
    const seq = ++fetchSeq;
    loading = true;
    error = '';
    try {
      const trimmed = q.trim();
      const cid = encodeURIComponent(customerId());
      const base = `https://api.klipy.com/api/v1/${KLIPY_KEY}`;
      const url = trimmed
        ? `${base}/gifs/search?q=${encodeURIComponent(trimmed)}&per_page=24&page=1&customer_id=${cid}`
        : `${base}/gifs/trending?per_page=24&page=1&customer_id=${cid}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (seq !== fetchSeq) return;
      // KLIPY wraps the list as { result, data: { data: [...] } }.
      results = mapData(json?.data?.data ?? []);
    } catch {
      if (seq !== fetchSeq) return;
      error = 'Impossible de charger les GIF.';
      results = [];
    } finally {
      if (seq === fetchSeq) loading = false;
    }
  }

  // Debounced search; loads trending when opened with an empty query.
  $effect(() => {
    if (!open) return;
    const q = query;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void fetchGifs(q), 350);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  });
</script>

{#if open}
  <div class="pointer-events-auto fixed inset-0 z-[130] flex items-end justify-center sm:items-center">
    <button
      type="button"
      class="absolute inset-0 bg-black/45 backdrop-blur-sm"
      aria-label="Fermer"
      onclick={onClose}
      transition:fade={{ duration: 150 }}
    ></button>
    <div
      class="relative flex max-h-[80vh] w-full flex-col rounded-t-2xl bg-[var(--cn-surface)] shadow-2xl sm:max-w-lg sm:rounded-2xl"
      transition:fly={{ y: 30, duration: 200 }}
    >
      <div class="flex items-center gap-2 border-b border-cn-border p-3">
        <div class="relative flex-1">
          <Search size={16} class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            bind:value={query}
            placeholder="Rechercher un GIF…"
            aria-label="Rechercher un GIF"
            class="w-full rounded-xl border border-cn-border bg-transparent py-2 pl-9 pr-3 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-cn-yellow/40"
          />
        </div>
        <button
          type="button"
          onclick={onClose}
          class="rounded-xl p-2 text-text-muted hover:bg-black/5 dark:hover:bg-white/10"
          aria-label="Fermer"
        >
          <X size={18} />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        {#if !KLIPY_KEY}
          <p class="py-10 text-center text-sm text-text-muted">
            Recherche de GIF non configurée (clé KLIPY absente).
          </p>
        {:else if loading && results.length === 0}
          <div class="flex justify-center py-10">
            <div
              class="h-6 w-6 animate-spin rounded-full border-4 border-cn-yellow border-t-transparent"
            ></div>
          </div>
        {:else if error}
          <p class="py-10 text-center text-sm text-red-500">{error}</p>
        {:else if results.length === 0}
          <p class="py-10 text-center text-sm text-text-muted">Aucun GIF trouvé.</p>
        {:else}
          <div class="columns-2 gap-2 sm:columns-3">
            {#each results as g (g.id)}
              <button
                type="button"
                onclick={() => {
                  onSelect(g.full);
                  onClose();
                }}
                class="mb-2 block w-full overflow-hidden rounded-lg outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-cn-yellow"
                aria-label="Envoyer ce GIF"
              >
                <img src={g.preview} alt="GIF" loading="lazy" class="w-full" />
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Attribution "Powered by KLIPY" required by the KLIPY API terms. -->
      <div class="border-t border-cn-border px-3 py-1.5 text-center text-[0.65rem] text-text-muted">
        Powered by KLIPY
      </div>
    </div>
  </div>
{/if}
