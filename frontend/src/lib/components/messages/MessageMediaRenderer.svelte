<script lang="ts">
  import {
    FileText,
    Download,
    CircleAlert,
    Image as ImageIcon,
    Video as VideoIcon,
    Mic,
  } from 'lucide-svelte';
  import VoiceMessagePlayer from './VoiceMessagePlayer.svelte';
  import type { MediaRef } from '$lib/media';

  interface Props {
    /** Parsed media descriptor from the message envelope, or null for text-only messages. */
    mediaRef: MediaRef | null;
    /** Decrypted object URL for the media blob, or null while loading. */
    blobUrl: string | null;
    /** True when the media failed to download or decrypt. */
    loadError: boolean;
    /** True when the media was removed by the 30-day retention policy. */
    mediaPurgedByRetention: boolean;
    /** Caption text shown below the media (or the full text for text-only messages). */
    textContent: string;
    /** When true, adjusts colours for the amber bubble used on own messages. */
    isOwn?: boolean;
    /** Pre-split text+link segments used to render the caption with clickable links. */
    textSegments?: Array<{ type: 'text' | 'link'; value: string }>;
    /** Called when the user clicks a link inside the caption. */
    onNavigateLink?: (e: MouseEvent) => void;
  }

  let {
    mediaRef = null,
    blobUrl = null,
    loadError = false,
    mediaPurgedByRetention = false,
    textContent = '',
    isOwn = false,
    textSegments = [],
    onNavigateLink: _onNavigateLink,
  }: Props = $props();

  let showLightbox = $state(false);

  function openLightbox(e: MouseEvent) {
    e.stopPropagation();
    if (!blobUrl) return;
    showLightbox = true;
  }

  function closeLightbox() {
    showLightbox = false;
  }

  function onLightboxKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') closeLightbox();
  }

  // Utilitaires dynamiques pour s'adapter au fond du message
  // isOwn = fond ambré (texte sombre), !isOwn = fond glassmorphism clair/sombre (texte adapté au thème)
  const glassBoxClass = $derived(
    isOwn
      ? 'bg-black/10 border-black/10 text-[#151B2C]'
      : 'bg-black/5 dark:bg-white/10 border-black/5 dark:border-white/10'
  );

  const textMutedClass = $derived(isOwn ? 'text-[#151B2C]/70' : 'text-text-muted');

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }

  function downloadBlob(url: string, fileName: string) {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  }
</script>

{#if mediaRef}
  <div class="overflow-hidden rounded-[1.1rem]">
    <!-- ================= IMAGE ================= -->
    {#if mediaRef.type === 'image'}
      {#if blobUrl}
        <div class="relative inline-block group/media">
          <button
            type="button"
            onclick={openLightbox}
            onpointerdown={(e) => e.stopPropagation()}
            aria-label="Ouvrir l'image en plein écran"
            class="block overflow-hidden rounded-[1.1rem] bg-black/5 dark:bg-white/5"
          >
            <img
              src={blobUrl}
              alt={mediaRef.fileName ?? 'Image partagée'}
              class="max-h-[22rem] max-w-full object-contain cursor-zoom-in transition-transform duration-500 md:group-hover/media:scale-[1.02]"
            />
          </button>

          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              downloadBlob(blobUrl!, mediaRef.fileName ?? 'image');
            }}
            class="absolute right-2.5 bottom-2.5 w-9 h-9 rounded-full bg-black/50 backdrop-blur-md text-white inline-flex items-center justify-center shadow-lg transition-all duration-300 md:opacity-0 md:group-hover/media:opacity-100 hover:bg-black/70 hover:scale-110 focus:opacity-100 outline-none"
            aria-label="Télécharger l'image"
            title="Télécharger"
          >
            <Download size={16} strokeWidth={2.5} />
          </button>
        </div>
      {:else if loadError}
        <div
          class="w-full max-wxs sm:w-64 aspect-[4/3] rounded-[1.1rem] border border-dashed {glassBoxClass} flex flex-col items-center justify-center gap-3 p-4 text-center"
        >
          <CircleAlert size={28} class="opacity-50" />
          <span class="text-xs font-medium leading-snug {textMutedClass}">
            {mediaPurgedByRetention
              ? 'Média expiré (rétention 30 jours).'
              : "Impossible de charger l'image."}
          </span>
        </div>
      {:else}
        <!-- Skeleton Image -->
        <div
          class="w-full max-w-[14rem] sm:w-56 aspect-[4/3] rounded-[1.1rem] {isOwn
            ? 'bg-black/10'
            : 'bg-black/5 dark:bg-white/10'} animate-pulse flex items-center justify-center"
        >
          <ImageIcon size={32} class="opacity-20" />
        </div>
      {/if}

      <!-- ================= VIDEO ================= -->
    {:else if mediaRef.type === 'video'}
      {#if blobUrl}
        <div class="relative inline-block group/media">
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            src={blobUrl}
            controls
            preload="metadata"
            onclick={(e) => e.stopPropagation()}
            class="rounded-[1.1rem] max-h-80 max-w-full sm:max-w-md bg-black/10 dark:bg-black/40 shadow-sm"
          ></video>

          <button
            type="button"
            onclick={openLightbox}
            class="absolute left-2.5 bottom-2.5 px-2.5 h-8 rounded-full bg-black/50 backdrop-blur-md text-white inline-flex items-center justify-center shadow-lg transition-all duration-300 hover:bg-black/70"
            aria-label="Ouvrir la vidéo en plein écran"
            title="Plein écran"
          >
            Plein écran
          </button>

          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              downloadBlob(blobUrl!, mediaRef.fileName ?? 'video.mp4');
            }}
            class="absolute right-2.5 top-2.5 w-9 h-9 rounded-full bg-black/50 backdrop-blur-md text-white inline-flex items-center justify-center shadow-lg transition-all duration-300 md:opacity-0 md:group-hover/media:opacity-100 hover:bg-black/70 hover:scale-110 focus:opacity-100 outline-none z-10"
            aria-label="Télécharger la vidéo"
            title="Télécharger"
          >
            <Download size={16} strokeWidth={2.5} />
          </button>
        </div>
      {:else if loadError}
        <div
          class="w-full max-w-[16rem] aspect-video rounded-[1.1rem] border border-dashed {glassBoxClass} flex flex-col items-center justify-center gap-3 p-4 text-center"
        >
          <CircleAlert size={28} class="opacity-50" />
          <span class="text-xs font-medium leading-snug {textMutedClass}">
            {mediaPurgedByRetention
              ? 'Vidéo expirée (rétention 30 jours).'
              : 'Impossible de charger la vidéo.'}
          </span>
        </div>
      {:else}
        <!-- Skeleton Video -->
        <div
          class="w-full max-w-[16rem] aspect-video rounded-[1.1rem] {isOwn
            ? 'bg-black/10'
            : 'bg-black/5 dark:bg-white/10'} animate-pulse flex items-center justify-center"
        >
          <VideoIcon size={32} class="opacity-20" />
        </div>
      {/if}

      <!-- ================= AUDIO ================= -->
    {:else if mediaRef.type === 'audio'}
      {#if blobUrl}
        <div class="min-w-[200px] sm:min-w-[240px]">
          <VoiceMessagePlayer
            src={blobUrl}
            onDownload={() => downloadBlob(blobUrl!, mediaRef.fileName ?? 'vocal.webm')}
          />
        </div>
      {:else if loadError}
        <div
          class="w-full sm:w-56 h-14 rounded-xl border border-dashed {glassBoxClass} flex items-center justify-center px-4 text-center"
        >
          <span class="text-[0.7rem] font-medium leading-snug {textMutedClass}">
            {mediaPurgedByRetention ? 'Audio expiré (30j)' : 'Erreur de chargement audio'}
          </span>
        </div>
      {:else}
        <!-- Skeleton Audio -->
        <div
          class="w-full sm:w-56 h-14 rounded-xl {isOwn
            ? 'bg-black/10'
            : 'bg-black/5 dark:bg-white/10'} animate-pulse flex items-center justify-center px-4"
        >
          <Mic size={20} class="opacity-20" />
          <div class="flex-1 ml-3 h-2 bg-current opacity-10 rounded-full"></div>
        </div>
      {/if}

      <!-- ================= FICHIER (Générique) ================= -->
    {:else}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="flex items-center gap-3.5 px-3.5 py-3 w-full max-w-full rounded-[1rem] border {glassBoxClass} backdrop-blur-md transition-colors group/file"
        ontouchstart={(e) => e.stopPropagation()}
        ontouchend={(e) => e.stopPropagation()}
      >
        <!-- Icône du fichier -->
        <div
          class="w-11 h-11 rounded-xl bg-current/10 flex items-center justify-center shrink-0 text-current opacity-80"
        >
          <FileText size={22} strokeWidth={2} />
        </div>

        <!-- Méta-données -->
        <div class="flex-1 min-w-0 overflow-hidden">
          <p class="text-[0.85rem] font-bold truncate leading-tight mb-0.5">
            {mediaRef.fileName ?? 'Fichier joint'}
          </p>
          {#if !mediaPurgedByRetention}
            <p class="text-[0.65rem] uppercase tracking-wider font-semibold opacity-60">
              {formatFileSize(mediaRef.size)}
            </p>
          {/if}
        </div>

        <!-- Actions -->
        {#if blobUrl}
          <button
            type="button"
            onclick={(e) => {
              e.stopPropagation();
              downloadBlob(blobUrl!, mediaRef!.fileName ?? 'fichier');
            }}
            aria-label="Télécharger le fichier"
            title="Télécharger"
            class="p-2.5 rounded-xl hover:bg-current/10 transition-all outline-none focus-visible:ring-2 focus-visible:ring-current shrink-0"
          >
            <Download
              size={18}
              strokeWidth={2.5}
              class="opacity-70 group-hover/file:opacity-100 transition-opacity"
            />
          </button>
        {:else if mediaPurgedByRetention}
          <span
            class="text-[0.65rem] font-bold text-red-600 dark:text-red-400 bg-red-500/10 px-2 py-1 rounded-md shrink-0"
          >
            Expiré
          </span>
        {:else if loadError}
          <CircleAlert size={18} class="opacity-50 text-red-500 shrink-0" />
        {:else}
          <div
            class="w-8 h-8 rounded-full border-2 border-current/20 border-t-current animate-spin shrink-0"
          ></div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Texte d'accompagnement (Légende du média) -->
  {#if textContent}
    <p class="mt-2 text-[0.95rem] leading-relaxed break-words whitespace-pre-wrap">
      {#each textSegments as segment, index (`${segment.type}-${segment.value}-${index}`)}
        {#if segment.type === 'link'}
          <a
            href={segment.value}
            target="_blank"
            rel="noopener noreferrer"
            class="underline underline-offset-2 decoration-current hover:opacity-80 font-medium transition-opacity"
            onclick={(e) => e.stopPropagation()}
          >
            {segment.value}
          </a>
        {:else}
          {segment.value}
        {/if}
      {/each}
    </p>
  {/if}
{/if}

{#if showLightbox && blobUrl && mediaRef && (mediaRef.type === 'image' || mediaRef.type === 'video')}
  <div
    class="fixed inset-0 z-[150] bg-black/92 backdrop-blur-sm"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Aperçu média"
    onkeydown={onLightboxKeydown}
  >
    <button
      type="button"
      class="absolute inset-0"
      onclick={closeLightbox}
      aria-label="Fermer l'aperçu média"
    ></button>

    <div class="relative z-10 h-full flex flex-col">
      <div class="flex items-center justify-between p-3 sm:p-4 text-white">
        <div class="text-xs sm:text-sm opacity-85 truncate pr-3">
          {mediaRef.fileName ?? 'Média'}
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="px-3 h-9 rounded-lg bg-white/15 hover:bg-white/25 transition-colors"
            onclick={(e) => {
              e.stopPropagation();
              downloadBlob(blobUrl, mediaRef.fileName ?? 'media');
            }}
          >
            Télécharger
          </button>
          <button
            type="button"
            class="px-3 h-9 rounded-lg bg-white/15 hover:bg-white/25 transition-colors"
            onclick={(e) => {
              e.stopPropagation();
              closeLightbox();
            }}
          >
            Fermer
          </button>
        </div>
      </div>

      <div class="flex-1 min-h-0 flex items-center justify-center p-3 sm:p-6">
        {#if mediaRef.type === 'image'}
          <img
            src={blobUrl}
            alt={mediaRef.fileName ?? 'Image'}
            class="max-h-full max-w-full object-contain select-none"
            style="touch-action: pinch-zoom;"
          />
        {:else}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            src={blobUrl}
            controls
            autoplay
            class="max-h-full max-w-full object-contain bg-black rounded-xl"
            style="touch-action: pinch-zoom;"
          ></video>
        {/if}
      </div>
    </div>
  </div>
{/if}
