<script lang="ts">
  import PostImage from './PostImage.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import LinkPreviewCard from '../messages/LinkPreviewCard.svelte';
  import PostMentionLink from './PostMentionLink.svelte';
  import PostCodeBlock from './PostCodeBlock.svelte';
  import PostCodespan from './PostCodespan.svelte';
  import { preprocessPostMarkdown } from '$lib/utils/posts/postMarkdown';
  import { ensureHljsTheme } from '$lib/utils/posts/hljsTheme';
  import { onMount } from 'svelte';
  import MediaLightbox from '$lib/components/shared/MediaLightbox.svelte';
  import { mediaAspectStyle, GALLERY_MEDIA_ASPECT } from '$lib/utils/mediaLayout';

  interface Props {
    /** The post whose markdown content and images are rendered. */
    post: PostEntity;
    /** Bearer token forwarded to PostImage for downloading and decrypting images. */
    authToken?: string;
  }

  let { post, authToken = '' }: Props = $props();

  onMount(() => {
    ensureHljsTheme();
  });

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

  function extractFirstUrl(text: string): string | null {
    const match = text.match(/https?:\/\/[^\s)>\]"]+/i);
    return match?.[0] ?? null;
  }

  const renderers = { link: PostMentionLink, code: PostCodeBlock, codespan: PostCodespan };

  const isTruncatable = $derived((post.markdown?.length ?? 0) > MAX_CHARS);
  const rawMarkdown = $derived(
    isTruncatable && !expanded ? post.markdown!.slice(0, MAX_CHARS) + '…' : (post.markdown ?? '')
  );
  const displayedMarkdown = $derived(preprocessPostMarkdown(rawMarkdown));
  const firstLink = $derived(post.markdown ? extractFirstUrl(post.markdown) : null);

</script>

{#if post.markdown}
  <div class="px-5 pb-3">
    <div class="text-[0.95rem] text-text-main leading-relaxed break-words">
      <div class="post-markdown max-w-none opacity-90 [&_br]:block [&_p+p]:mt-3 [&_p:first-child]:mt-0">
        <SvelteMarkdown source={displayedMarkdown} {renderers} options={{ gfm: true, breaks: true }} />
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
        <div
          class="relative w-full bg-black/5 dark:bg-white/5 overflow-hidden"
          style={mediaAspectStyle(post.images[0].width, post.images[0].height)}
        >
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
          <div
            class="relative w-full overflow-hidden bg-black/5 dark:bg-white/5"
            style={mediaAspectStyle(img.width, img.height, GALLERY_MEDIA_ASPECT)}
          >
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
  <MediaLightbox
    open={lightboxIndex !== null}
    onClose={closeLightbox}
    ariaLabel="Galerie d'images"
    showPrev={post.images.length > 1}
    showNext={post.images.length > 1}
    onPrev={prevImage}
    onNext={nextImage}
    dotCount={post.images.length}
    dotIndex={lightboxIndex}
    onDotSelect={(i) => (lightboxIndex = i)}
  >
    <PostImage media={post.images[lightboxIndex]} {authToken} galleryMode />
  </MediaLightbox>
{/if}
