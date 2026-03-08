<script lang="ts">
  import { SmilePlus, Search, X } from 'lucide-svelte';
  import { clickOutside } from '$lib/actions/clickOutside';

  interface Props {
    onGifSelected: (gifUrl: string) => void;
  }

  let { onGifSelected }: Props = $props();

  let showPicker = $state(false);
  let searchQuery = $state('');
  let gifs = $state<any[]>([]);
  let isLoading = $state(false);
  let searchTimeout: number | null = null;

  // Tenor API - get your free key at https://developers.google.com/tenor/guides/quickstart
  const TENOR_API_KEY =
    import.meta.env.VITE_TENOR_API_KEY || 'AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ'; // Demo key
  const TENOR_LIMIT = 20;

  async function searchGifs(query: string) {
    if (!query.trim()) {
      // Load trending if empty
      await loadTrending();
      return;
    }

    isLoading = true;
    try {
      const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=${TENOR_API_KEY}&client_key=canari&limit=${TENOR_LIMIT}&media_filter=gif`;
      const res = await fetch(url);
      const data = await res.json();
      gifs = data.results || [];
    } catch (error) {
      console.error('Erreur recherche GIF:', error);
      gifs = [];
    } finally {
      isLoading = false;
    }
  }

  async function loadTrending() {
    isLoading = true;
    try {
      const url = `https://tenor.googleapis.com/v2/featured?key=${TENOR_API_KEY}&client_key=canari&limit=${TENOR_LIMIT}&media_filter=gif`;
      const res = await fetch(url);
      const data = await res.json();
      gifs = data.results || [];
    } catch (error) {
      console.error('Erreur chargement GIFs tendances:', error);
      gifs = [];
    } finally {
      isLoading = false;
    }
  }

  function handleSearchInput(value: string) {
    searchQuery = value;

    if (searchTimeout !== null) {
      clearTimeout(searchTimeout);
    }

    searchTimeout = window.setTimeout(() => {
      void searchGifs(value);
    }, 500);
  }

  function handleGifClick(gif: any) {
    // Use the preview image URL for better performance
    const gifUrl = gif.media_formats?.tinygif?.url || gif.media_formats?.gif?.url;
    if (gifUrl) {
      onGifSelected(gifUrl);
      showPicker = false;
      searchQuery = '';
      gifs = [];
    }
  }

  function togglePicker() {
    showPicker = !showPicker;
    if (showPicker && gifs.length === 0) {
      void loadTrending();
    }
  }

  function closePicker() {
    showPicker = false;
    searchQuery = '';
    gifs = [];
  }
</script>

<div class="relative">
  <button
    onclick={togglePicker}
    class="w-11 h-11 text-gray-400 rounded-full flex items-center justify-center flex-shrink-0 hover:text-cn-dark hover:bg-gray-200 transition-colors"
    aria-label="Envoyer un GIF"
    title="Envoyer un GIF"
  >
    <SmilePlus size={20} />
  </button>

  {#if showPicker}
    <div
      use:clickOutside={closePicker}
      class="absolute bottom-full left-0 mb-2 w-[320px] h-[400px] bg-white border border-cn-border rounded-2xl shadow-2xl overflow-hidden flex flex-col z-50"
    >
      <!-- Header -->
      <div class="px-4 py-3 border-b border-cn-border flex items-center justify-between">
        <div class="flex items-center gap-2 flex-1">
          <Search size={18} class="text-gray-400" />
          <input
            type="text"
            placeholder="Rechercher un GIF..."
            value={searchQuery}
            oninput={(e) => handleSearchInput(e.currentTarget.value)}
            class="flex-1 text-sm outline-none"
          />
        </div>
        <button
          onclick={closePicker}
          class="p-1 rounded hover:bg-gray-100 transition-colors"
          aria-label="Fermer"
        >
          <X size={18} />
        </button>
      </div>

      <!-- GIF Grid -->
      <div class="flex-1 overflow-y-auto p-2">
        {#if isLoading}
          <div class="flex items-center justify-center h-full">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-cn-dark"></div>
          </div>
        {:else if gifs.length === 0}
          <div class="flex items-center justify-center h-full text-sm text-gray-400">
            Aucun GIF trouvé
          </div>
        {:else}
          <div class="grid grid-cols-2 gap-2">
            {#each gifs as gif (gif.id)}
              <button
                onclick={() => handleGifClick(gif)}
                class="aspect-square rounded-lg overflow-hidden hover:ring-2 hover:ring-cn-yellow transition-all bg-gray-100"
              >
                <img
                  src={gif.media_formats?.tinygif?.url || gif.media_formats?.gif?.url}
                  alt={gif.content_description || 'GIF'}
                  class="w-full h-full object-cover"
                  loading="lazy"
                />
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Footer -->
      <div class="px-4 py-2 border-t border-cn-border text-xs text-gray-400 text-center">
        Powered by Tenor
      </div>
    </div>
  {/if}
</div>
