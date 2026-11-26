<script lang="ts">
  import PostMedia from './PostMedia.svelte';
  import { isReel, type PostEntity, type PostMediaRef } from '$lib/posts/api';
  import ReplayCard from './ReplayCard.svelte';
  import { isReplay } from '$lib/live/replayTimeline';
  import { fullScreenPageOf } from '$lib/reels/fullScreenPost';
  import ReelViewer from '$lib/components/reels/ReelViewer.svelte';
  import { NO_FURTHER_REELS } from '$lib/reels/allReels';
  import { feedReelsContinue } from '$lib/reels/infiniteReels';
  import { ReelStream } from '$lib/reels/reelStream.svelte';
  import LinkPreviewCard from '../messages/LinkPreviewCard.svelte';
  import PostMarkdown from './PostMarkdown.svelte';
  import FormCard from './FormCard.svelte';
  import PostEventCard from './PostEventCard.svelte';
  import { planPostAttachments, type PostCardItem } from '$lib/utils/posts/postAttachments';
  import type { AttachedFormInfo } from '$lib/posts/attachedForms.svelte';
  import { watchClampOverflow } from '$lib/utils/posts/clampOverflow';
  import { ensureHljsTheme } from '$lib/utils/posts/hljsTheme';
  import { onMount, tick } from 'svelte';
  import { endVideoHandBack } from '$lib/utils/videoResume';
  import MediaLightbox from '$lib/components/shared/MediaLightbox.svelte';
  import { postAuthorName } from '$lib/posts/postAuthorName';
  import {
    DEFAULT_MEDIA_ASPECT,
    FORM_CARD_PLACEHOLDER_MIN_HEIGHT,
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
  import { downloadDecryptedFile } from '$lib/utils/fileDownload';

  interface Props {
    /** The post whose markdown content and images are rendered. */
    post: PostEntity;
    /** Bearer token forwarded to PostMedia for downloading and decrypting attachments. */
    authToken?: string;
    /** When true, always show the full markdown (no truncation). */
    fullContent?: boolean;
    /** The signed-in reader, handed to the reel viewer so a double tap there likes; absent, it cannot. */
    likerId?: string;
    /**
     * The post's attached forms, read by the card (`attachedFormsLoader`): `ids` in the post's
     * order, `infos` once each is read. Absent (the moderation preview), no form card is drawn and a
     * link to a form keeps its own card.
     */
    attachedForms?: { ids: string[]; infos: AttachedFormInfo[] };
    /**
     * The CanaReels viewer opened from this card shows THIS post only, whatever the reader's
     * "Défilement infini" switch says: no stream after it, no order switch (owner, 2026-11-26). Set
     * by a surface that is not the feed, where a swipe into other people's reels is out of place
     * (the moderation preview of a reported post).
     */
    reelAlone?: boolean;
  }

  let {
    post,
    authToken = '',
    fullContent = false,
    likerId,
    attachedForms,
    reelAlone = false,
  }: Props = $props();

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

  /** A live replay: no media, a card that opens the CanaReels viewer (`ReplayCard`). */
  const replay = $derived(isReplay(post));

  /**
   * TEXT, MEDIA, CARDS - IN THAT ORDER, ALWAYS (owner, 2026-11-15). The plan decides the text as
   * drawn (a URL with a card leaves it), the gallery's pictures and videos, and the card zone in its
   * fixed order (event, forms, files, links), each form once, and whether its lone card is a hero
   * (`planPostAttachments`). The poll and the action bar follow, drawn by `PostCard`.
   */
  const plan = $derived(planPostAttachments(post, attachedForms?.ids ?? [], replay));

  /** Media follows the text, so the text hands over 8 px instead of the 12 it keeps before the action bar. */
  const hasMedia = $derived(plan.media.length > 0 && Boolean(authToken));

  // Pictures and videos only. The gallery's cells are drawn FROM this array, so a cell's position
  // IS its lightbox index - a document (a card) can never renumber the pictures after it.
  const lightboxMedia = $derived<PostMediaRef[]>(plan.media);
  /** Square cells and a "+N" past four (`postGalleryLayout`), for a post of two media or more. */
  const gallery = $derived(postGalleryLayout(lightboxMedia.length));

  /** Who published the post and when: the media viewer's title and information panel. */
  const postInfo = $derived({ senderName: postAuthorName(post), sentAt: post.publishedAt });
  const lightboxItem = $derived(lightboxIndex === null ? null : lightboxMedia[lightboxIndex]);

  function openLightbox(i: number) {
    Log.d('PostContent.openLightbox', { postId: post.id, index: i, of: lightboxMedia.length });
    showMedia(i);
  }

  /** Moves the viewer to media `i` (or closes it): the previous file's URL is dropped with it. */
  function showMedia(i: number | null) {
    lightboxFile = null;
    lightboxIndex = i;
  }

  function closeLightbox() {
    showMedia(null);
  }

  /**
   * The decrypted file of the media the gallery lightbox shows, once the whole of it is in this
   * device's pool (`PostMedia`'s `onLoaded`), keyed by its media id so a swipe to the next one never
   * offers the previous one's bytes. It is what makes "Télécharger" available in a grid's viewer as
   * it is in a single media's (owner inventory, 2026-11-26).
   */
  let lightboxFile = $state.raw<{ mediaId: string; url: string } | null>(null);
  const lightboxDownload = $derived.by(() => {
    const item = lightboxItem;
    const file = lightboxFile;
    if (!item || !file || file.mediaId !== item.mediaId) return undefined;
    const fallback = resolveMediaType(item) === 'video' ? 'video' : 'image';
    return () => void downloadDecryptedFile(file.url, item.fileName ?? fallback);
  });

  function prevMedia() {
    if (lightboxIndex === null || lightboxMedia.length === 0) return;
    showMedia((lightboxIndex - 1 + lightboxMedia.length) % lightboxMedia.length);
  }

  function nextMedia() {
    if (lightboxIndex === null || lightboxMedia.length === 0) return;
    showMedia((lightboxIndex + 1) % lightboxMedia.length);
  }

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
    return {
      onnear: near,
      onleave: () => nearMedia.delete(media.mediaId),
      rootMargin: VIDEO_NEAR_MARGIN,
      leaveMargin: VIDEO_LEAVE_MARGIN,
    };
  }

  /**
   * A VIDEO'S BAND IS A SCREEN AHEAD, MEASURED IN SCREENS (owner, 2026-11-10: "precharger pour ne
   * jamais attendre"). Its head - two segments fetched, decrypted, a frame decoded - is far more work
   * than a picture's, and the 400 px the pictures use is under half a phone screen: a reader scrolling
   * reached the card before its first frame. One full height of the scroll box ahead (`100%` of the
   * root, whatever the phone) opens the stream while the previous card is still being read; it is
   * given back two heights away, so a card resting near an edge never reopens it on a small scroll.
   * A distance, not a timer: getting it wrong costs one head early, never a wrong answer.
   */
  const VIDEO_NEAR_MARGIN = '100% 0px';
  const VIDEO_LEAVE_MARGIN = '200% 0px';

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
  /** The carousel media the CanaReels viewer opens on (the tapped cell); 0 off a carousel. */
  let reelStartIndex = $state(0);
  /**
   * Whether the viewer swipes on, read at the tap: on to the CanaReels stream, or nothing after this
   * post when "Défilement infini des CanaReels" is off (`feedReelsContinue`, owner 2026-11-10).
   */
  let reelContinues = $state(true);
  /**
   * THE STREAM AFTER THE OPENED VIDEO, IN THE READER'S ORDER AND WITH ITS SWITCH (owner, 2026-11-11):
   * the CanaReels entry's own implementation (`reels/reelStream.svelte.ts`). A change of order starts
   * over at the top of the new list, this post still first. Built on the first opening, never with
   * the card: most cards are never opened full screen.
   */
  let reelStream = $state.raw<ReelStream | null>(null);
  /**
   * FULL SCREEN IS THE CANAREELS VIEWER (owner, 2026-11-10): a tap on a feed video - a CanaReel or a
   * post's video - opens the viewer on THAT video, at the time it had reached (`videoResume`), and a
   * swipe goes on to the next reels. The page the post is drawn as decides (`fullScreenPageOf`): a
   * post of one video is a `reel` page, a grid of pictures and videos a `carousel` page opened on the
   * tapped cell. A post the viewer cannot draw (a poll, a file, a linked event beside the video) keeps
   * the media viewer - a fact read from the post, said in the log.
   */
  const fullPage = $derived(fullScreenPageOf(post));

  function openReelViewer(mediaIndex = 0) {
    Log.d('PostContent.openReelViewer', { postId: post.id, page: fullPage, mediaIndex });
    reelStartIndex = mediaIndex;
    reelContinues = !reelAlone && feedReelsContinue();
    if (reelContinues) (reelStream ??= new ReelStream()).open();
    reelViewerOpen = true;
  }

  /**
   * Closes the viewer, then ends this post's hand-back waits once its players are destroyed - their
   * `onDestroy` IS the hand-back, so the wait ends after it, never before (`videoResume`).
   */
  async function closeReelViewer() {
    reelViewerOpen = false;
    reelStream?.close();
    await tick();
    for (const media of postMedia) endVideoHandBack(media.mediaId);
  }

  /** The card zone's key: a file by position and id, a form by id, a link by URL. */
  function cardKey(card: PostCardItem, index: number): string {
    if (card.kind === 'file') return `file:${index}:${card.media.mediaId}`;
    if (card.kind === 'form') return `form:${card.formId}`;
    if (card.kind === 'link') return `link:${card.url}`;
    return 'event';
  }

  /** What a tap on a video of this post opens: the CanaReels viewer, else `undefined` (the media viewer). */
  function videoOpener(media: PostMediaRef, index: number): (() => void) | undefined {
    if (resolveMediaType(media) !== 'video') return undefined;
    if (reel || fullPage === 'reel') return () => openReelViewer(0);
    if (fullPage === 'carousel') return () => openReelViewer(index);
    Log.d('PostContent.videoOpener', { postId: post.id, page: fullPage, viewer: 'media' });
    return undefined;
  }
</script>

{#if plan.markdown}
  <div class="px-4 {hasMedia ? 'pb-2' : 'pb-3'}">
    <div class="text-text-main text-sm wrap-break-word">
      <PostMarkdown
        markdown={plan.markdown}
        bind:element={markdownEl}
        class={clamped ? 'line-clamp-8' : ''}
      />
      {#if !fullContent && (overflows || expanded)}
        <button
          type="button"
          onclick={() => (expanded = !expanded)}
          class="text-accent-text mt-1 text-xs font-bold outline-none hover:underline focus-visible:underline"
        >
          {expanded ? m.post_voir_moins() : m.post_voir_plus()}
        </button>
      {/if}
    </div>
  </div>
{/if}

{#if replay}
  <ReplayCard {post} onOpen={() => openReelViewer(0)} />
{:else if hasMedia}
  <div
    class="w-full overflow-hidden first:rounded-t-2xl last:rounded-b-2xl {plan.markdown
      ? ''
      : 'mt-2'}"
  >
    {#if reel}
      {@render singleMedia(lightboxMedia[0], true)}
    {:else}
      <!-- MULTI-MEDIA: SQUARE CELLS, A "+N" PAST FOUR (user, 2026-10-05). Cells that kept their own
           shapes left blank areas beside the shorter pictures of a two-column grid. A square is
           also a height known before the download, so the box below never moves. Only pictures
           and videos are cells - drawn FROM `lightboxMedia`, so a cell's position IS its viewer
           index; files and audio are cards of the card zone below. -->
      {#if gallery.shape === 'single'}
        {@render singleMedia(lightboxMedia[0])}
      {:else if gallery.shape !== 'none'}
        <!-- `feature` is a 3x2 grid: the first cell spans 2x2, so it is a square twice the size of
             the two stacked on its right - three squares in a row are a third of the width each,
             too small to read on a phone. EVERY cell, the spanning one included, carries
             `aspect-square`: its height then comes from its width and never from the picture inside
             it, which would otherwise stretch the rows it spans. -->
        <div
          class="grid gap-0.5 overflow-hidden {gallery.shape === 'feature'
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
                onOpen={videoOpener(media, i) ?? (() => openLightbox(i))}
              />
              {#if overflowCell}
                <button
                  type="button"
                  onclick={() => openLightbox(i)}
                  class="bg-cn-scrim/60 focus-visible:ring-accent/50 absolute inset-0 flex items-center justify-center text-white outline-none focus-visible:ring-4 focus-visible:ring-inset"
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
    {/if}
  </div>
{/if}

<!-- THE CARD ZONE (owner, 2026-11-15): every attachment that is not a picture or a video, in ONE card
     family (`AttachmentCard`) and a fixed order - event, attached forms, files, the text's links - on
     the text's 16 px inset, under the media and above the poll and the action bar. A lone card with
     little text is drawn large (`plan.hero`). -->
{#if plan.cards.length > 0}
  <div class="space-y-2 px-4 pb-3 {hasMedia || replay ? 'pt-3' : ''}" data-post-cards>
    {#each plan.cards as card, i (cardKey(card, i))}
      {#if card.kind === 'event' && post.linkedCalendarEvent}
        <PostEventCard postId={post.id} event={post.linkedCalendarEvent} hero={plan.hero} />
      {:else if card.kind === 'form'}
        {@const info = attachedForms?.infos.find((f) => f.id === card.formId)}
        {#if info}
          <FormCard
            formId={info.id}
            href="/forms/{info.id}?redirect=/posts"
            title={info.title}
            submitted={info.submitted}
            opensAt={info.opensAt}
            hero={plan.hero}
          />
        {:else}
          <div
            class="animate-pulse rounded-2xl border border-black/5 bg-black/5 dark:border-white/10 dark:bg-white/5"
            style="min-height: {FORM_CARD_PLACEHOLDER_MIN_HEIGHT}"
            aria-hidden="true"
            data-form-placeholder
          ></div>
        {/if}
      {:else if card.kind === 'file' && authToken}
        <div use:nearViewport={watchNear(card.media)}>
          <PostMedia
            media={card.media}
            {authToken}
            compact={!plan.hero}
            deferred={!nearMedia.has(card.media.mediaId)}
            {postInfo}
          />
        </div>
      {:else if card.kind === 'link'}
        <LinkPreviewCard url={card.url} standalone hero={plan.hero} />
      {/if}
    {/each}
  </div>
{/if}

<!-- One picture or video drawn at its own shape: a single-media post, and a reel. -->
{#snippet singleMedia(media: PostMediaRef, asReel = false)}
  {@const reserved = reservesAspectRatio(resolveMediaType(media))}
  {@const isVideo = resolveMediaType(media) === 'video'}
  <div use:nearViewport={watchNear(media)}>
    <!-- A PICTURE IS FULL-BLEED WITHIN THE CARD (owner, 2026-11-09; the inset and rounding of 2026-10-01
         existed because edge-to-edge corners cut across the card's corner, which the block above now
         clips to when it is the card's first or last block). The box is sized by `aspect-ratio` under
         a `max-height`, so it keeps `w-full`: without it a tall video shrinks its width to fit the
         ceiling instead of being cropped by it. -->
    <div
      class="relative overflow-hidden {reserved
        ? `w-full ${isVideo ? 'bg-cn-card' : 'bg-black/5 dark:bg-white/5'}`
        : 'w-full px-4 pb-1'}"
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
        onOpen={videoOpener(media, 0)}
        durationMs={asReel ? post.durationMs : null}
        {postInfo}
      />
    </div>
    {#if media.caption && !asReel}
      <p class="text-text-muted px-4 pt-2 pb-1 text-xs italic">{media.caption}</p>
    {/if}
  </div>
{/snippet}

{#if reelViewerOpen}
  <ReelViewer
    startPost={post}
    startMediaIndex={reelStartIndex}
    {authToken}
    {likerId}
    loadPage={reelContinues && reelStream ? reelStream.loader : NO_FURTHER_REELS}
    orderChoice={reelContinues && reelStream ? reelStream.choice : undefined}
    onClose={closeReelViewer}
  />
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
    onDotSelect={showMedia}
    onDownload={lightboxDownload}
  >
    <PostMedia
      media={lightboxMedia[lightboxIndex]}
      {authToken}
      galleryMode
      onLoaded={(url) => (lightboxFile = { mediaId: lightboxMedia[lightboxIndex!].mediaId, url })}
    />
  </MediaLightbox>
{/if}
