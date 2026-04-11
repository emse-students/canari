<script lang="ts">
  import { MediaService } from '$lib/media';
  import type { MediaRef } from '$lib/media';
  import { Image as ImageIcon, AlertCircle } from 'lucide-svelte';

  interface Props {
    media: {
      mediaId: string;
      key: string;
      iv: string;
      mimeType: string;
      size: number;
      fileName?: string;
    };
    authToken: string;
  }

  let { media, authToken }: Props = $props();

  let blobUrl = $state<string | null>(null);
  let loading = $state(true);
  let loadError = $state('');

  // Svelte 5 : Gestion réactive du téléchargement et du nettoyage mémoire
  $effect(() => {
    if (!authToken) {
      loading = false;
      loadError = 'Jeton d\'authentification manquant';
      return;
    }

    let destroyed = false;
    let currentUrl: string | null = null;
    loading = true;
    loadError = '';

    const mediaService = new MediaService();

    mediaService
      .downloadAndDecrypt(
        {
          type: 'image',
          mediaId: media.mediaId,
          key: media.key,
          iv: media.iv,
          mimeType: media.mimeType,
          size: media.size,
          fileName: media.fileName,
        } as MediaRef,
        authToken
      )
      .then((url) => {
        if (destroyed) {
          URL.revokeObjectURL(url);
        } else {
          blobUrl = url;
          currentUrl = url;
        }
      })
      .catch((err) => {
        if (!destroyed) {
          loadError = err instanceof Error ? err.message : 'Impossible de charger l\'image';
        }
      })
      .finally(() => {
        if (!destroyed) {
          loading = false;
        }
      });

    // Fonction de nettoyage exécutée à la destruction du composant ou au changement de props
    return () => {
      destroyed = true;
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl);
      }
    };
  });

  // Fonction d'ouverture compatible Web et Tauri (Desktop)
  function openBlob(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!blobUrl) return;

    if ((window as any).__TAURI_INTERNALS__) {
      const win = window.open('', '_blank');
      if (win) {
        win.location.href = blobUrl;
      }
    } else {
      window.open(blobUrl, '_blank', 'noopener,noreferrer');
    }
  }
</script>

{#if loading}
  <div class="absolute inset-0 flex items-center justify-center bg-black/5 dark:bg-white/5 animate-pulse">
    <ImageIcon size={32} class="opacity-20 text-text-muted" strokeWidth={1.5} />
  </div>
{:else if loadError}
  <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center bg-red-500/5 dark:bg-red-500/10 border border-dashed border-red-500/20">
    <AlertCircle size={24} class="text-red-500 opacity-70" strokeWidth={2} />
    <span class="text-xs font-semibold text-red-600 dark:text-red-400">{loadError}</span>
  </div>
{:else if blobUrl}
  <button
    type="button"
    onclick={openBlob}
    class="block w-full h-full outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50 focus-visible:z-10 group/img cursor-zoom-in"
    aria-label="Agrandir l'image"
  >
    <img
      src={blobUrl}
      alt={media.fileName ?? 'Image de la publication'}
      class="w-full h-full object-cover transition-transform duration-700 group-hover/img:scale-105"
      loading="lazy"
    />
  </button>
{/if}
