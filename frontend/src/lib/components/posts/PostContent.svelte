<script lang="ts">
  import PostMedia from './PostMedia.svelte';
  import { isReel, type PostEntity, type PostMediaRef } from '$lib/posts/api';
  import ReelViewer from '$lib/components/reels/ReelViewer.svelte';
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import LinkPreviewCard from '../messages/LinkPreviewCard.svelte';
  import { POST_MARKDOWN_RENDERERS as renderers } from './postMarkdownRenderers';
  import { extractFirstUrl } from '$lib/utils/chat/messageDisplay';
  import { preprocessPostMarkdown } from '$lib/utils/posts/postMarkdown';
  import { ensureHljsTheme } from '$lib/utils/posts/hljsTheme';
  import { onMount } from 'svelte';
  import MediaLightbox from '$lib/components/shared/MediaLightbox.svelte';
  import { postAuthorName } from '$lib/posts/postAuthorName';
  import {
    mediaAspectStyle,
    resolveMediaType,
    reservesAspectRatio,
    GALLERY_MEDIA_ASPECT,
  } from '$lib/utils/mediaLayout';
  import { m } from '$lib/paraglide/messages';
  import { nearViewport } from '$lib/actions/nearViewport';
  import { SvelteSet } from 'svelte/reactivity';

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

  /**
   * A collapsed post shows 8 lines before "Voir plus" - the `line-clamp-8` in the markup,
   * which Tailwind must find spelt out (a computed class name generates no CSS).
   *
   * THE POST IS CLAMPED AFTER IT IS RENDERED, NEVER CUT BEFORE. It used to be cut at 400 characters
   * of SOURCE and then rendered, so a cut inside `**gras**` left an unmatched `**` on screen, and the
   * emphasis appeared only once "Voir plus" revealed its closing pair (user, 2026-09-28) - the same
   * for a link, a code block or a table. Clamping the rendered text by lines cannot break any
   * syntax, and it is how the comments below have always done it (`PostComments`, `line-clamp-5`).
   */
  let expanded = $state(false);
  let markdownEl: HTMLDivElement | undefined = $state();
  /** Whether the rendered post is taller than the clamp - measured, so a short post shows no button. */
  let overflows = $state(false);
  const clamped = $derived(!fullContent && !expanded);

  $effect(() => {
    // Measured only WHILE clamped: expanded, the box shows everything and would report no overflow,
    // which would hide the "Voir moins" that has to fold it back.
    if (!markdownEl || !clamped) return;
    const el = markdownEl;
    const measure = () => {
      overflows = el.scrollHeight > el.clientHeight + 1;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });

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

  /** Who published the post and when: the media viewer's title and information panel. */
  const postInfo = $derived({ senderName: postAuthorName(post), sentAt: post.createdAt });
  const lightboxItem = $derived(lightboxIndex === null ? null : lightboxMedia[lightboxIndex]);

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

  const displayedMarkdown = $derived(preprocessPostMarkdown(post.markdown ?? ''));
  const firstLink = $derived(post.markdown ? extractFirstUrl(post.markdown) : null);

  /**
   * Which attachments have come near the viewport, by media id.
   *
   * THE BOX IS WHAT AN OBSERVER CAN WATCH, AND THIS COMPONENT OWNS IT. `PostMedia` renders a
   * different root per media type - and none at all while a file placeholder is in flow - so the
   * gate cannot live inside it. Here there is exactly one wrapper per attachment, and it already
   * reserves the aspect ratio, so nothing moves when the picture lands.
   */
  const nearMedia = new SvelteSet<string>();

  /**
   * A CanaReel (C7) is drawn VERTICAL in the feed - a 9:16 box, the video covering it - rather than
   * as an ordinary attachment, whose box follows the file's own ratio under a ceiling that crops a
   * phone's portrait clip. Touching it opens the full-screen reel viewer instead of the media viewer.
   */
  const reel = $derived(isReel(post));
  let reelViewerOpen = $state(false);
</script>

{#if post.markdown}
  <div class="px-5 pb-3">
    <div class="text-text-main text-sm leading-relaxed wrap-break-word">
      <div
        bind:this={markdownEl}
        class="post-markdown max-w-none opacity-90 {clamped
          ? 'line-clamp-8'
          : ''} [&_br]:block [&_h1]:mt-1 [&_h1]:mb-0.5 [&_h1]:text-xl [&_h1]:leading-tight [&_h1]:font-bold [&_h1]:tracking-tight [&_h1+_p]:mt-2 [&_h2]:mt-1 [&_h2]:mb-0.5 [&_h2]:text-lg [&_h2]:leading-snug [&_h2]:font-bold [&_h2+_p]:mt-2 [&_h3]:mt-0.5 [&_h3]:mb-0 [&_h3]:text-base [&_h3]:leading-snug [&_h3]:font-bold [&_h3+_p]:mt-1.5 [&_p+p]:mt-3 [&_p:first-child]:mt-0"
      >
        <SvelteMarkdown
          source={displayedMarkdown}
          {renderers}
          options={{ gfm: true, breaks: true }}
        />
      </div>
      {#if !fullContent && (overflows || expanded)}
        <button
          type="button"
          onclick={() => (expanded = !expanded)}
          class="mt-1 text-xs font-bold text-amber-600 outline-none hover:underline focus-visible:underline dark:text-amber-400"
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
  <div class="mt-1 mb-1 w-full px-3">
    {#if reel}
      {@const media = postMedia[0]}
      <div use:nearViewport={{ onnear: () => nearMedia.add(media.mediaId) }}>
        <div
          class="relative mx-auto aspect-9/16 h-[70svh] max-w-full overflow-hidden rounded-lg bg-black"
          data-reel-card
        >
          <PostMedia
            {media}
            {authToken}
            letterbox
            deferred={!nearMedia.has(media.mediaId)}
            onOpen={() => (reelViewerOpen = true)}
            {postInfo}
          />
        </div>
      </div>
      {#if reelViewerOpen}
        <ReelViewer startPost={post} {authToken} onClose={() => (reelViewerOpen = false)} />
      {/if}
    {:else if postMedia.length === 1}
      {@const media = postMedia[0]}
      {@const reserved = reservesAspectRatio(resolveMediaType(media))}
      <div use:nearViewport={{ onnear: () => nearMedia.add(media.mediaId) }}>
        <!-- A PICTURE IS INSET AND ROUNDED, NO LONGER FULL-BLEED (user, 2026-10-01, Mi 9T): run
             edge to edge, its square corners cut across the card's 18 px ones. The block's `px-3` +
             `rounded-lg` is the concentric pair - 18 px outside, 12 px in, 8 px left, which is also
             the scale's card corner. The inset is PADDING on the block, never a margin on the box:
             the box is sized by `aspect-ratio` under a `max-height`, so without `w-full` a tall
             video shrinks its width to fit the ceiling instead of being cropped by it. A document
             card adds `px-2`, which lands it on the post text's 20 px. -->
        <div
          class="relative overflow-hidden {reserved
            ? 'w-full rounded-lg bg-black/5 dark:bg-white/5'
            : 'w-full px-2 pb-1'}"
          style={reserved ? mediaAspectStyle(media.width, media.height) : ''}
        >
          <!-- Single attachment: PostMedia handles its own lightbox/download -->
          <PostMedia
            {media}
            {authToken}
            letterbox={reserved}
            deferred={!nearMedia.has(media.mediaId)}
            {postInfo}
          />
        </div>
        {#if media.caption}
          <p class="text-text-muted px-2 pt-2 pb-1 text-xs italic">{media.caption}</p>
        {/if}
      </div>
    {:else}
      <!-- Multi-media gallery: centralized lightbox with navigation for image/video -->
      <div
        class="grid grid-cols-2 gap-0.5 overflow-hidden rounded-lg bg-white/20 sm:gap-1 dark:bg-black/20"
      >
        {#each postMedia as media (media.mediaId)}
          {@const lightboxIdx = lightboxMedia.indexOf(media)}
          <div
            use:nearViewport={{ onnear: () => nearMedia.add(media.mediaId) }}
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
              deferred={!nearMedia.has(media.mediaId)}
              onOpen={lightboxIdx === -1 ? undefined : () => openLightbox(lightboxIdx)}
            />
            {#if media.caption}
              <p
                class="text-2xs pointer-events-none absolute right-0 bottom-0 left-0 truncate bg-black/50 px-2 py-1 text-white/90"
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
    info={{
      ...postInfo,
      fileName: lightboxItem?.fileName,
      sizeBytes: lightboxItem?.size,
      width: lightboxItem?.width,
      height: lightboxItem?.height,
    }}
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
