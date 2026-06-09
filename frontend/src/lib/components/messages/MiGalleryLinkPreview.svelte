<script lang="ts">
  import { ExternalLink, Images } from '@lucide/svelte';

  interface ExternalPreviewPayload {
    url: string;
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
  }

  interface Props {
    /** URL de l'album MiGallery (utilisée comme href du lien). */
    url: string;
    /** Données de preview récupérées via l'API MiGallery (og-preview / link-preview). */
    preview: ExternalPreviewPayload | null;
    /** Indique si les données sont en cours de chargement. */
    isLoading: boolean;
  }

  let { url, preview, isLoading }: Props = $props();

  const hasImage = $derived(Boolean(preview?.image));
</script>

<a
  href={url}
  target="_blank"
  rel="noopener noreferrer"
  class="group mt-3 block rounded-2xl border border-black/5 dark:border-white/10 bg-white/45 dark:bg-black/25 backdrop-blur-xl transition-all duration-300 hover:bg-white/70 dark:hover:bg-black/40 hover:border-amber-500/35 hover:shadow-md overflow-hidden"
>
  <!-- Couverture de l'album -->
  <div class="relative w-full aspect-video overflow-hidden bg-black/8 dark:bg-white/8">
    {#if isLoading}
      <div class="absolute inset-0 animate-pulse bg-black/10 dark:bg-white/10"></div>
    {:else if hasImage}
      <img
        src={preview?.image}
        alt=""
        class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
        loading="lazy"
      />
      <!-- Dégradé bas pour lisibilité si texte superposé -->
      <div class="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-black/20 to-transparent"></div>
    {:else}
      <!-- Placeholder si pas d'image -->
      <div class="absolute inset-0 flex items-center justify-center opacity-20">
        <Images size={40} strokeWidth={1.5} />
      </div>
    {/if}
  </div>

  <!-- Métadonnées texte -->
  <div class="flex items-start justify-between gap-3 px-4 py-3">
    <div class="min-w-0 flex-1">
      <span
        class="mb-1.5 inline-flex items-center rounded-md bg-amber-500/12 dark:bg-amber-400/10 px-2 py-0.5 text-[0.65rem] uppercase tracking-wider font-bold text-amber-800 dark:text-amber-300"
      >
        MiGallery
      </span>

      {#if isLoading}
        <div class="h-4 w-3/4 rounded bg-black/8 dark:bg-white/8 animate-pulse mb-1.5"></div>
        <div class="h-3 w-1/2 rounded bg-black/6 dark:bg-white/6 animate-pulse"></div>
      {:else}
        <p
          class="text-sm font-bold text-text-main leading-snug line-clamp-2 group-hover:text-amber-700 dark:group-hover:text-amber-300 transition-colors duration-300"
        >
          {preview?.title || 'Album photo'}
        </p>
        {#if preview?.description}
          <p class="mt-0.5 text-xs text-text-muted leading-snug line-clamp-1">
            {preview.description}
          </p>
        {/if}
      {/if}
    </div>

    <div
      class="shrink-0 self-center opacity-35 text-text-muted group-hover:text-amber-600 dark:group-hover:text-amber-400 group-hover:opacity-100 transition-all duration-300 group-hover:translate-x-0.5"
    >
      <ExternalLink size={18} strokeWidth={2.25} />
    </div>
  </div>
</a>
