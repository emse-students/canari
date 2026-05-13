<script lang="ts">
  import PostImage from './PostImage.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import LinkPreviewCard from '../messages/LinkPreviewCard.svelte';
  import { ChevronLeft, ChevronRight } from 'lucide-svelte';

  interface Props {
    /** The post whose markdown content and images are rendered. */
    post: PostEntity;
    /** Bearer token forwarded to PostImage for downloading and decrypting images. */
    authToken?: string;
  }

  let { post, authToken = '' }: Props = $props();

  const MAX_CHARS = 400;
  let expanded = $state(false);

  // Gallery lightbox
  let lightboxIndex = $state<number | null>(null);

  function openLightbox(i: number) {
    lightboxIndex = i;
  }

  function closeLightbox() {
    lightboxIndex = null;
  }

  function prevImage() {
    if (lightboxIndex === null || !post.images) return;
    lightboxIndex = (lightboxIndex - 1 + post.images.length) % post.images.length;
  }

  function nextImage() {
    if (lightboxIndex === null || !post.images) return;
    lightboxIndex = (lightboxIndex + 1) % post.images.length;
  }

  function onLightboxKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') prevImage();
    if (e.key === 'ArrowRight') nextImage();
  }

  function extractFirstUrl(text: string): string | null {
    const match = text.match(/https?:\/\/[^\s)>\]"]+/i);
    return match?.[0] ?? null;
  }

  const isTruncatable = $derived((post.markdown?.length ?? 0) > MAX_CHARS);
  const displayedMarkdown = $derived(
    isTruncatable && !expanded ? post.markdown!.slice(0, MAX_CHARS) + '…' : (post.markdown ?? '')
  );
  const firstLink = $derived(post.markdown ? extractFirstUrl(post.markdown) : null);

</script>

{#if post.markdown}
  <div class="px-5 pb-3">
    <div class="text-[0.95rem] text-text-main leading-relaxed break-words">
      <div class="prose prose-sm dark:prose-invert max-w-none opacity-90">
        <SvelteMarkdown source={displayedMarkdown} options={{ gfm: true, breaks: true }} />
      </div>
      {#if isTruncatable}
        <button
          type="button"
          onclick={() => (expanded = !expanded)}
          class="mt-1 text-[0.82rem] font-bold text-amber-600 dark:text-amber-400 hover:underline outline-none focus-visible:underline"
        >
          {expanded ? 'Voir moins' : 'Voir plus'}
        </button>
      {/if}
    </div>
    {#if firstLink}
      <LinkPreviewCard url={firstLink} />
    {/if}
  </div>
{/if}

{#if post.images && post.images.length > 0 && authToken}
  <div class="w-full mt-1">
    {#if post.images.length === 1}
      <div>
        <div class="relative w-full max-h-[75vh] bg-black/5 dark:bg-white/5 flex items-center justify-center overflow-hidden">
          <!-- Single image: PostImage handles its own lightbox -->
          <PostImage media={post.images[0]} {authToken} />
        </div>
        {#if post.images[0].caption}
          <p class="px-4 pt-2 pb-1 text-xs text-text-muted italic">{post.images[0].caption}</p>
        {/if}
      </div>
    {:else}
      <!-- Multi-image gallery: centralized lightbox with navigation -->
      <div class="grid grid-cols-2 gap-0.5 sm:gap-1 bg-white/20 dark:bg-black/20">
        {#each post.images as img, i (img.mediaId)}
          <div class="relative aspect-square w-full overflow-hidden bg-black/5 dark:bg-white/5">
            <PostImage media={img} {authToken} onOpen={() => openLightbox(i)} />
            {#if img.caption}
              <p class="absolute bottom-0 left-0 right-0 bg-black/50 px-2 py-1 text-[0.65rem] text-white/90 truncate pointer-events-none">{img.caption}</p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<!-- Gallery lightbox with navigation -->
{#if lightboxIndex !== null && post.images && post.images[lightboxIndex]}
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Galerie d'images"
    tabindex="-1"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
    onclick={closeLightbox}
    onkeydown={onLightboxKeydown}
  >
    <!-- Close -->
    <button
      type="button"
      class="absolute top-4 right-4 text-white/80 hover:text-white text-3xl leading-none z-10"
      onclick={closeLightbox}
      aria-label="Fermer"
    >✕</button>

    <!-- Prev -->
    {#if post.images.length > 1}
      <button
        type="button"
        class="absolute left-3 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
        onclick={(e) => { e.stopPropagation(); prevImage(); }}
        aria-label="Image précédente"
      >
        <ChevronLeft size={28} strokeWidth={2.5} />
      </button>
    {/if}

    <!-- Image -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="max-w-full max-h-full flex items-center justify-center" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
      <PostImage media={post.images[lightboxIndex]} {authToken} galleryMode />
    </div>

    <!-- Next -->
    {#if post.images.length > 1}
      <button
        type="button"
        class="absolute right-3 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
        onclick={(e) => { e.stopPropagation(); nextImage(); }}
        aria-label="Image suivante"
      >
        <ChevronRight size={28} strokeWidth={2.5} />
      </button>
    {/if}

    <!-- Dots -->
    {#if post.images.length > 1}
      <div class="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1.5">
        {#each post.images as _, i (i)}
          <button
            type="button"
            onclick={(e) => { e.stopPropagation(); lightboxIndex = i; }}
            class="w-2 h-2 rounded-full transition-all {i === lightboxIndex ? 'bg-white' : 'bg-white/40'}"
            aria-label="Image {i + 1}"
          ></button>
        {/each}
      </div>
    {/if}
  </div>
{/if}
