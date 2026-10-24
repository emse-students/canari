<script lang="ts">
  import PostMedia from './PostMedia.svelte';
  import { isReel, type PostEntity, type PostMediaRef } from '$lib/posts/api';
  import ReelViewer from '$lib/components/reels/ReelViewer.svelte';
  import LinkPreviewCard from '../messages/LinkPreviewCard.svelte';
  import PostMarkdown from './PostMarkdown.svelte';
  import { extractFirstUrl } from '$lib/utils/chat/messageDisplay';
  import { watchClampOverflow } from '$lib/utils/posts/clampOverflow';
  import { ensureHljsTheme } from '$lib/utils/posts/hljsTheme';
  import { onMount } from 'svelte';
  import MediaLightbox from '$lib/components/shared/MediaLightbox.svelte';
  import { postAuthorName } from '$lib/posts/postAuthorName';
  import {
    DEFAULT_MEDIA_ASPECT,
    REEL_FALLBACK_ASPECT,
    mediaAspectStyle,
    resolveMediaType,
    reservesAspectRatio,
  } from '$lib/utils/mediaLayout';
  import { m } from '$lib/paraglide/messages';
  import { nearViewport } from '$lib/actions/nearViewport';
  import { SvelteSet } from 'svelte/reactivity';
  import { postGalleryLayout } from '$lib/utils/posts/postGalleryLayout';
  import { Log } from '$lib/utils/Log';

  interface Props {
    /** The post whose markdown content and images are rendered. */
    post: PostEntity;
    /** Bearer token forwarded to PostMedia for downloading and decrypting attachments. */
    authToken?: string;
    /** When true, always show the full markdown (no truncation). */
    fullContent?: boolean;
    /** The signed-in reader, handed to the reel viewer so a double tap there likes; absent, it cannot. */
    likerId?: string;
  }

  let { post, authToken = '', fullContent = false, likerId }: Props = $props();

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
    return watchClampOverflow(markdownEl, (value) => (overflows = value));
  });

  // Gallery lightbox (only for image/video media)
  let lightboxIndex = $state<number | null>(null);

  const postMedia = $derived<PostMediaRef[]>(post.media ?? post.images ?? []);
  /** Image and video are the only types the lightbox can display. */
  function isLightboxable(media: PostMediaRef): boolean {
    const type = resolveMediaType(media);
    return type === 'image' || type === 'video';
  }

  // Compacted on purpose: a document is skipped. The gallery's cells are drawn FROM this array, so
  // a cell's position IS its lightbox index - a document can never renumber the pictures after it.
  const lightboxMedia = $derived<PostMediaRef[]>(postMedia.filter(isLightboxable));
  /** Files and audio: never squeezed into a square cell, drawn as rows under the grid instead. */
  const documentMedia = $derived<PostMediaRef[]>(
    postMedia.filter((media) => !isLightboxable(media))
  );
  /** Square cells and a "+N" past four (`postGalleryLayout`), for a post of two media or more. */
  const gallery = $derived(postGalleryLayout(lightboxMedia.length));

  /** Who published the post and when: the media viewer's title and information panel. */
  const postInfo = $derived({ senderName: postAuthorName(post), sentAt: post.publishedAt });
  const lightboxItem = $derived(lightboxIndex === null ? null : lightboxMedia[lightboxIndex]);

  function openLightbox(i: number) {
    Log.d('PostContent.openLightbox', { postId: post.id, index: i, of: lightboxMedia.length });
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
   * The band watch of one attachment. A VIDEO is watched both ways: leaving the band - at a farther
   * edge than the one it entered by (`nearViewport`'s `leaveMargin`) - takes it out of `nearMedia`, which defers its `PostMedia` again and so closes its stream and unmounts its
   * player (reels audit, 2026-10-11: every reel ever scrolled near kept downloading and kept its
   * decoder). A picture stays one-shot - once fetched there is nothing worth giving back.
   */
  function watchNear(media: PostMediaRef) {
    const near = () => nearMedia.add(media.mediaId);
    if (resolveMediaType(media) !== 'video') return { onnear: near };
    return { onnear: near, onleave: () => nearMedia.delete(media.mediaId) };
  }

  /**
   * A CanaReel (C7) is drawn in the SAME box as any video (`singleMedia`): the clip's own ratio under
   * the `--media-max-height` ceiling, the whole frame contained with a blurred backdrop, 9:16 only when it
   * carries no dimensions. Touching it opens the full-screen reel viewer instead of the media viewer.
   */
  const reel = $derived(isReel(post));

  /**
   * The shape a video is drawn at when it carries no dimensions: a reel is vertical by definition,
   * an old post video keeps the ordinary 4:3. Known dimensions always win (`mediaAspectStyle`).
   */
  function videoFallback(asReel: boolean): number {
    return asReel ? REEL_FALLBACK_ASPECT : DEFAULT_MEDIA_ASPECT;
  }
  let reelViewerOpen = $state(false);
</script>

{#if post.markdown}
  <div class="px-5 pb-3">
    <div class="text-text-main text-sm leading-relaxed wrap-break-word">
      <PostMarkdown
        markdown={post.markdown}
        bind:element={markdownEl}
        class="opacity-90 {clamped ? 'line-clamp-8' : ''}"
      />
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
      {@render singleMedia(postMedia[0], true)}
      {#if reelViewerOpen}
        <ReelViewer
          startPost={post}
          {authToken}
          {likerId}
          onClose={() => (reelViewerOpen = false)}
        />
      {/if}
    {:else if postMedia.length === 1}
      {@render singleMedia(postMedia[0])}
    {:else}
      <!-- MULTI-MEDIA: SQUARE CELLS, A "+N" PAST FOUR (user, 2026-10-05). Cells that kept their own
           shapes left blank areas beside the shorter pictures of a two-column grid. A square is
           also a height known before the download, so the box below never moves. Only pictures
           and videos are cells - drawn FROM `lightboxMedia`, so a cell's position IS its viewer
           index; files and audio are rows under the grid, drawn as a single attachment is. -->
      {#if gallery.shape === 'single'}
        {@render singleMedia(lightboxMedia[0])}
      {:else if gallery.shape !== 'none'}
        <!-- `feature` is a 3x2 grid: the first cell spans 2x2, so it is a square twice the size of
             the two stacked on its right - three squares in a row are a third of the width each,
             too small to read on a phone. EVERY cell, the spanning one included, carries
             `aspect-square`: its height then comes from its width and never from the picture inside
             it, which would otherwise stretch the rows it spans. -->
        <div
          class="grid gap-0.5 overflow-hidden rounded-lg {gallery.shape === 'feature'
            ? 'grid-cols-3 grid-rows-2'
            : 'grid-cols-2'}"
          data-post-gallery={gallery.shape}
        >
          {#each lightboxMedia.slice(0, gallery.visible) as media, i (`${i}:${media.mediaId}`)}
            {@const featured = gallery.shape === 'feature' && i === 0}
            {@const overflowCell = gallery.overflow > 0 && i === gallery.visible - 1}
            <div
              use:nearViewport={watchNear(media)}
              class="relative aspect-square overflow-hidden bg-black/5 dark:bg-white/5 {featured
                ? 'col-span-2 row-span-2'
                : ''}"
              data-gallery-cell
            >
              <!-- For a VIDEO, `letterbox` is what fills the caller's box, cropped (`object-cover`);
                   without it the clip draws its own 16:9 card inside the square. A still keeps the
                   plain `object-cover` crop, which is what a square cell is for. -->
              <PostMedia
                {media}
                {authToken}
                letterbox={resolveMediaType(media) === 'video'}
                videoFit="cover"
                deferred={!nearMedia.has(media.mediaId)}
                onOpen={() => openLightbox(i)}
              />
              {#if overflowCell}
                <button
                  type="button"
                  onclick={() => openLightbox(i)}
                  class="bg-cn-scrim/60 absolute inset-0 flex items-center justify-center text-white outline-none focus-visible:ring-4 focus-visible:ring-amber-500/50 focus-visible:ring-inset"
                  aria-label={m.post_gallery_more_label({ count: gallery.overflow })}
                  data-gallery-more
                  data-double-tap-defers
                >
                  <span class="text-3xl font-bold" aria-hidden="true"
                    >{m.post_gallery_more_count({ count: gallery.overflow })}</span
                  >
                </button>
              {:else if media.caption}
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
      {#each documentMedia as media, i (`${i}:${media.mediaId}`)}
        <div class={gallery.shape !== 'none' || i > 0 ? 'mt-2' : ''} data-gallery-document>
          {@render singleMedia(media)}
        </div>
      {/each}
    {/if}
  </div>
{/if}

<!-- One attachment drawn at its own shape: a single-attachment post, a lone picture beside files,
     and each file row under a gallery. -->
{#snippet singleMedia(media: PostMediaRef, asReel = false)}
  {@const reserved = reservesAspectRatio(resolveMediaType(media))}
  {@const isVideo = resolveMediaType(media) === 'video'}
  <div use:nearViewport={watchNear(media)}>
    <!-- A PICTURE IS INSET AND ROUNDED, NO LONGER FULL-BLEED (user, 2026-10-01, Mi 9T): run
         edge to edge, its square corners cut across the card's 18 px ones. The block's `px-3` +
         `rounded-lg` is the concentric pair - 18 px outside, 12 px in, 8 px left, which is also
         the scale's card corner. The inset is PADDING on the block, never a margin on the box:
         the box is sized by `aspect-ratio` under a `max-height`, so without `w-full` a tall
         video shrinks its width to fit the ceiling instead of being cropped by it. A document
         card adds `px-2`, which lands it on the post text's 20 px. -->
    <div
      class="relative overflow-hidden {reserved
        ? `w-full rounded-lg ${isVideo ? 'bg-cn-surface' : 'bg-black/5 dark:bg-white/5'}`
        : 'w-full px-2 pb-1'}"
      style={reserved ? mediaAspectStyle(media.width, media.height, videoFallback(asReel)) : ''}
      data-reel-card={asReel ? '' : undefined}
      data-video-box={isVideo ? '' : undefined}
    >
      <!-- Single attachment: PostMedia handles its own lightbox/download -->
      <PostMedia
        {media}
        {authToken}
        letterbox={reserved}
        deferred={!nearMedia.has(media.mediaId)}
        onOpen={asReel ? () => (reelViewerOpen = true) : undefined}
        {postInfo}
      />
    </div>
    {#if media.caption && !asReel}
      <p class="text-text-muted px-2 pt-2 pb-1 text-xs italic">{media.caption}</p>
    {/if}
  </div>
{/snippet}

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
