<script lang="ts">
  import PostMedia from './PostMedia.svelte';
  import type { PostEntity, PostMediaRef } from '$lib/posts/api';
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import LinkPreviewCard from '../messages/LinkPreviewCard.svelte';
  import PostMentionLink from './PostMentionLink.svelte';
  import PostCodeBlock from './PostCodeBlock.svelte';
  import PostCodespan from './PostCodespan.svelte';
  import { extractFirstUrl } from '$lib/utils/chat/messageDisplay';
  import { preprocessPostMarkdown } from '$lib/utils/posts/postMarkdown';
  import { ensureHljsTheme } from '$lib/utils/posts/hljsTheme';
  import { onMount } from 'svelte';
  import MediaLightbox from '$lib/components/shared/MediaLightbox.svelte';
  import {
    mediaAspectStyle,
    resolveMediaType,
    reservesAspectRatio,
    GALLERY_MEDIA_ASPECT,
  } from '$lib/utils/mediaLayout';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The post whose markdown content and images are rendered. */
    post: PostEntity;
    /** Bearer token forwarded to PostMedia for downloading and decrypting attachments. */
    authToken?: string;
    /** When true, always show the full markdown (no truncation). */
    fullContent?: boolean;
  }

  let { post, authToken = '', fullContent = false }: Props = $props();

  onMount(() => {
    ensureHljsTheme();
  });

  const MAX_CHARS = 400;
  let expanded = $state(false);

  // Gallery lightbox (only for image/video media)
  let lightboxIndex = $state<number | null>(null);

  const postMedia = $derived<PostMediaRef[]>(post.media ?? post.images ?? []);
  /** Image and video are the only types the lightbox can display. */
  function isLightboxable(media: PostMediaRef): boolean {
    const type = resolveMediaType(media);
    return type === 'image' || type === 'video';
  }

  // Compacted on purpose: a document is skipped. A grid position is therefore NOT
  // a lightbox index - openLightbox is always given the index in THIS array.
  const lightboxMedia = $derived<PostMediaRef[]>(postMedia.filter(isLightboxable));

  function openLightbox(i: number) {
    lightboxIndex = i;
  }

  function closeLightbox() {
    lightboxIndex = null;
  }

  function prevMedia() {
    if (lightboxIndex === null || lightboxMedia.length === 0) return;
    lightboxIndex = (lightboxIndex - 1 + lightboxMedia.length) % lightboxMedia.length;
  }

  function nextMedia() {
    if (lightboxIndex === null || lightboxMedia.length === 0) return;
    lightboxIndex = (lightboxIndex + 1) % lightboxMedia.length;
  }

  const renderers = { link: PostMentionLink, code: PostCodeBlock, codespan: PostCodespan };

  const isTruncatable = $derived(!fullContent && (post.markdown?.length ?? 0) > MAX_CHARS);
  const rawMarkdown = $derived(
    isTruncatable && !expanded ? post.markdown!.slice(0, MAX_CHARS) + '…' : (post.markdown ?? '')
  );
  const displayedMarkdown = $derived(preprocessPostMarkdown(rawMarkdown));
  const firstLink = $derived(post.markdown ? extractFirstUrl(post.markdown) : null);
</script>

{#if post.markdown}
  <div class="px-5 pb-3">
    <div class="text-text-main text-[0.95rem] leading-relaxed break-words">
      <div
        class="post-markdown max-w-none opacity-90 [&_br]:block [&_h1]:mt-1 [&_h1]:mb-0.5 [&_h1]:text-[1.45rem] [&_h1]:leading-tight [&_h1]:font-extrabold [&_h1]:tracking-tight [&_h1+_p]:mt-2 [&_h2]:mt-1 [&_h2]:mb-0.5 [&_h2]:text-[1.25rem] [&_h2]:leading-snug [&_h2]:font-bold [&_h2+_p]:mt-2 [&_h3]:mt-0.5 [&_h3]:mb-0 [&_h3]:text-[1.1rem] [&_h3]:leading-snug [&_h3]:font-bold [&_h3+_p]:mt-1.5 [&_p+p]:mt-3 [&_p:first-child]:mt-0"
      >
        <SvelteMarkdown
          source={displayedMarkdown}
          {renderers}
          options={{ gfm: true, breaks: true }}
        />
      </div>
      {#if isTruncatable}
        <button
          type="button"
          onclick={() => (expanded = !expanded)}
          class="mt-1 text-[0.82rem] font-bold text-amber-600 outline-none hover:underline focus-visible:underline dark:text-amber-400"
        >
          {expanded ? m.post_voir_moins() : m.post_voir_plus()}
        </button>
      {/if}
    </div>
    {#if firstLink}
      <LinkPreviewCard url={firstLink} />
    {/if}
  </div>
{/if}

{#if postMedia.length > 0 && authToken}
  <div class="mt-1 w-full">
    {#if postMedia.length === 1}
      {@const media = postMedia[0]}
      {@const reserved = reservesAspectRatio(resolveMediaType(media))}
      <div>
        <!-- An image is deliberately full-bleed; a document card is not, so it
             lines up with the post text (px-5) instead of touching the edges. -->
        <div
          class="relative w-full overflow-hidden {reserved
            ? 'bg-black/5 dark:bg-white/5'
            : 'px-5 pb-1'}"
          style={reserved ? mediaAspectStyle(media.width, media.height) : ''}
        >
          <!-- Single attachment: PostMedia handles its own lightbox/download -->
          <PostMedia {media} {authToken} />
        </div>
        {#if media.caption}
          <p class="text-text-muted px-4 pt-2 pb-1 text-xs italic">{media.caption}</p>
        {/if}
      </div>
    {:else}
      <!-- Multi-media gallery: centralized lightbox with navigation for image/video -->
      <div class="grid grid-cols-2 gap-0.5 bg-white/20 sm:gap-1 dark:bg-black/20">
        {#each postMedia as media (media.mediaId)}
          {@const lightboxIdx = lightboxMedia.indexOf(media)}
          <div
            class="relative w-full overflow-hidden bg-black/5 dark:bg-white/5 {lightboxIdx === -1
              ? 'flex items-center p-2'
              : ''}"
            style={lightboxIdx === -1
              ? ''
              : mediaAspectStyle(media.width, media.height, GALLERY_MEDIA_ASPECT)}
          >
            <PostMedia
              {media}
              {authToken}
              onOpen={lightboxIdx === -1 ? undefined : () => openLightbox(lightboxIdx)}
            />
            {#if media.caption}
              <p
                class="pointer-events-none absolute right-0 bottom-0 left-0 truncate bg-black/50 px-2 py-1 text-[0.65rem] text-white/90"
              >
                {media.caption}
              </p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<!-- Gallery lightbox with navigation -->
{#if lightboxIndex !== null && lightboxMedia[lightboxIndex]}
  <MediaLightbox
    open={lightboxIndex !== null}
    onClose={closeLightbox}
    ariaLabel={m.post_gallery_label()}
    showPrev={lightboxMedia.length > 1}
    showNext={lightboxMedia.length > 1}
    onPrev={prevMedia}
    onNext={nextMedia}
    dotCount={lightboxMedia.length}
    dotIndex={lightboxIndex}
    onDotSelect={(i) => (lightboxIndex = i)}
  >
    <PostMedia media={lightboxMedia[lightboxIndex]} {authToken} galleryMode />
  </MediaLightbox>
{/if}
