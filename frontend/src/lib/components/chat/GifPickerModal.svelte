<script lang="ts">
  import { X, Search } from '@lucide/svelte';
  import { fly } from 'svelte/transition';
  import { portal } from '$lib/actions/portal';
  import { m } from '$lib/paraglide/messages';

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
      // KLIPY wraps the list as { result, data: { data: […] } }.
      results = mapData(json?.data?.data ?? []);
    } catch {
      if (seq !== fetchSeq) return;
      error = m.chat_gif_load_error();
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
  <!--
    PORTALLED, BECAUSE `fixed` MEANS "THE VIEWPORT" ONLY WHILE NO ANCESTOR CLAIMS IT.

    This one component is opened from the chat composer and from a post's comment box, and it
    misbehaved in exactly one of them. `PostCard`'s card carries `hover:-translate-y-0.5`, and a
    non-`none` transform makes an element the containing block for every `position: fixed`
    DESCENDANT - so while the pointer was over the card, this modal and its backdrop were confined
    to the card's own rectangle. Measured 2026-09-13 on a 400x200 stand-in card: the overlay reads
    1265x400 at (0,0) with no transform and 400x200 at (109,99) with `translateY(-2px)` - the card,
    exactly. It came back the moment the transform went.

    That is why it "did weird things" intermittently and why it was worse on a phone: `:hover`
    STICKS after a tap until something else is tapped, so on touch the card holds the transform for
    as long as the picker is open. The 300ms `transition-all` keeps it non-`none` on the way out too.

    `use:portal` is the fix and the repo already knew this shape - `fixedPopover.test.ts` refuses a
    viewport-positioned panel left in the tree, naming this precise cause. A `fixed inset-0` overlay
    is the same fact in a different spelling, and this one was simply not in that family.
  -->
  <div
    use:portal
    class="pointer-events-auto fixed inset-0 z-(--z-sheet) flex items-end justify-center sm:items-center"
  >
    <!--
      NO SCRIM (user, 2026-09-13: *"pas besoin de fond fonce"*). It stays a full-bleed button so a
      click anywhere outside the panel still closes it - the target is what the scrim was FOR, and
      the dimming was never load-bearing. `fade` goes with it: there is nothing left to fade.
    -->
    <button
      type="button"
      class="absolute inset-0"
      aria-label={m.common_close_label()}
      onclick={onClose}
    ></button>
    <div
      class="relative flex max-h-[80vh] w-full flex-col rounded-t-2xl bg-(--cn-surface) shadow-2xl sm:max-w-lg sm:rounded-2xl"
      transition:fly={{ y: 30, duration: 200 }}
    >
      <div class="border-cn-border flex items-center gap-2 border-b p-3">
        <div class="relative flex-1">
          <Search size={16} class="text-text-muted absolute top-1/2 left-3 -translate-y-1/2" />
          <input
            bind:value={query}
            placeholder={m.chat_gif_search_placeholder()}
            aria-label={m.chat_gif_search_label()}
            class="border-cn-border text-text-main focus:ring-cn-yellow/40 w-full rounded-xl border bg-transparent py-2 pr-3 pl-9 text-sm focus:ring-2 focus:outline-none"
          />
        </div>
        <button
          type="button"
          onclick={onClose}
          class="ui-icon-button text-text-muted rounded-xl hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={m.common_close_label()}
        >
          <X size={18} />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        {#if !KLIPY_KEY}
          <p class="text-text-muted py-10 text-center text-sm">
            {m.chat_gif_not_configured()}
          </p>
        {:else if loading && results.length === 0}
          <div class="flex justify-center py-10">
            <div
              class="border-cn-yellow h-6 w-6 animate-spin rounded-full border-4 border-t-transparent"
            ></div>
          </div>
        {:else if error}
          <p class="py-10 text-center text-sm text-red-500">{error}</p>
        {:else if results.length === 0}
          <p class="text-text-muted py-10 text-center text-sm">{m.chat_no_gif_found()}</p>
        {:else}
          <div class="columns-2 gap-2 sm:columns-3">
            {#each results as g (g.id)}
              <button
                type="button"
                onclick={() => {
                  onSelect(g.full);
                  onClose();
                }}
                class="focus-visible:ring-cn-yellow mb-2 block w-full overflow-hidden rounded-lg outline-none hover:opacity-90 focus-visible:ring-2"
                aria-label={m.chat_send_gif_action_label()}
              >
                <img src={g.preview} alt="GIF" loading="lazy" class="w-full" />
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Attribution "Powered by KLIPY" required by the KLIPY API terms. -->
      <div class="border-cn-border text-text-muted text-2xs border-t px-3 py-1.5 text-center">
        Powered by KLIPY
      </div>
    </div>
  </div>
{/if}
