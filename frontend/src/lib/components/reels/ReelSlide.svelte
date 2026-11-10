<script lang="ts" module>
  /** The reels already reported as carrying no video - shared by every slide, never read reactively. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a log's memory, never rendered
  const reportedWithoutVideo = new Set<string>();
  /** The rows reported as outside the CanaReels rule (`fullScreenPageOf`), same lifetime. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a log's memory, never rendered
  const reportedOutOfRule = new Set<string>();
</script>

<script lang="ts">
  /**
   * One reel in the full-screen viewer (C7): its video filling the screen, and who published it with
   * the caption over the bottom of the picture.
   *
   * THE OVERLAY IS THE POST CARD'S, NOT A SECOND COPY (user, 2026-10-16): the publisher's picture,
   * name and link are `PostAuthorAvatar` / `postAuthorName` / `postAuthorHref`, the text is
   * `PostMarkdown` - so an association post shows the association, a hidden author links nowhere,
   * and the description renders as its card does. Two lines, then "Voir plus" unfolds it in place.
   *
   * ONLY THE CURRENT REEL MOUNTS A PLAYER. The video is `PostMedia`'s, in gallery mode - the same
   * download, stream (a segmented video plays as it arrives) and failure state as everywhere else,
   * with `VideoPlayer`, its bar and the app's one sound answer. A neighbour draws its FIRST FRAME as
   * a picture instead (`reelPosters`, else the publisher's ThumbHash), because every mounted player
   * counts as an open viewer and claims playback (`followVideoSound`); once the reel on screen has
   * SETTLED (whole and playing) the NEXT reel preloads its video (`ReelPreload`), so its player
   * takes the warm path and shows the first frame the moment the swipe lands.
   *
   * THE SAVE BUTTON (`ReelSaveButton`) is in the player's bar next to the volume button, for every
   * reel (user, 2026-10-09: "public or not"). Nothing here claims the video is protected.
   *
   * A POST OF ONE PICTURE IS A PAGE TOO (user, 2026-10-19, as Instagram's Reels mix them): the
   * same frame, overlay and rail, its picture in place of the video and no player bar
   * (`reels/fullScreenPost.ts` says which page a row is). THE RAIL (`ReelActionRail`) is drawn
   * when the viewer hands its actions over - a post's reel, never a conversation's.
   *
   * A POST OF SEVERAL PICTURES AND VIDEOS IS A CAROUSEL PAGE (owner, 2026-11-06, as on Instagram):
   * its media sit side by side in a STRIP inside the one frame, the viewer says which is visible
   * (`mediaIndex`) and where a held horizontal drag has taken the strip (`mediaDragX`), and dots
   * under the top bar say the position. Each media is a `ReelMediaPane`, which owns its download,
   * player and settle; `carouselMediaRole` says which pane is active, drawn and fetched ahead. The
   * caption, the rail, the reactions and the comments belong to the POST, never to a media: they
   * do not move with the strip. The rail's save and sound follow the VISIBLE media - a video has
   * them, a picture has neither (no picture save exists; a photo page has none either).
   *
   * A LIVE REPLAY IS A PAGE TOO (owner, 2026-11-09): no strip, no media - `ReplayPane` plays the
   * live's own segments in the shared player, and the rail's save is the replay's (segment by
   * segment). It has NO repost anywhere (the rail never had one: its "Envoyer a..." sends a link).
   */
  import VideoPoster from '$lib/components/shared/VideoPoster.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import PostAuthorAvatar from '$lib/components/posts/PostAuthorAvatar.svelte';
  import PostMarkdown from '$lib/components/posts/PostMarkdown.svelte';
  import {
    postAuthorHref,
    postAuthorLinkLabel,
    postAuthorName,
    revealedPostAuthor,
  } from '$lib/posts/postAuthorName';
  import { republishedByText } from '$lib/posts/republication';
  import RevealedAuthorLine from '$lib/components/posts/RevealedAuthorLine.svelte';
  import StudentsOnlyChip from '$lib/components/posts/StudentsOnlyChip.svelte';
  import { ChevronLeft, ChevronRight, Repeat2 } from '@lucide/svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { REEL_FRAME_RATIO } from '$lib/reels/reelFrame';
  import { watchClampOverflow } from '$lib/utils/posts/clampOverflow';
  import { exactDate, timeAgo } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';
  import ReelFrame from './ReelFrame.svelte';
  import ReelSaveButton from './ReelSaveButton.svelte';
  import ReelMediaPane from './ReelMediaPane.svelte';
  import ReplayPane from './ReplayPane.svelte';
  import { saveReplayFlow } from '$lib/live/replaySaveFlow';
  import DoubleTapHeart from '$lib/components/posts/DoubleTapHeart.svelte';
  import { doubleTapLike } from '$lib/actions/doubleTapLike';
  import type { Point } from '$lib/utils/viewerGestures';
  import ReelActionRail from './ReelActionRail.svelte';
  import {
    fullScreenMediaKindOf,
    fullScreenMediaListOf,
    fullScreenMediaOf,
    fullScreenPageOf,
  } from '$lib/reels/fullScreenPost';
  import { carouselMediaRole } from '$lib/reels/reelViewerNav';
  import { GESTURE } from '$lib/utils/viewerGestures';
  import { reactionTotal, type ReelRailActions } from '$lib/reels/reelRail';
  import { commentCountOf } from '$lib/posts/commentChange';

  interface Props {
    post: PostEntity;
    authToken: string;
    /** The reel on screen: it plays. */
    active: boolean;
    /** The reel after the current one: its video is fetched ahead. */
    preload: boolean;
    /**
     * A double tap on the reel asks the viewer to like it. True when the reel now carries the
     * reader's reaction (given now or before), which is when the heart is drawn. Absent - a reel
     * opened from a conversation, which is not a post - a double tap does nothing.
     */
    onLike?: () => boolean;
    /** The rail's actions (`ReelActionRail`); absent, no rail is drawn. */
    rail?: ReelRailActions;
    /**
     * The reel on screen is SETTLED: its whole file is in and, for a video, it is playing. Only
     * then does the viewer start the next reel's preload, so a weak link spends itself on the reel
     * being watched first.
     */
    onReady?: () => void;
    /**
     * The media service answered `410`: the reel's file is gone for good. A conversation's reel
     * records it on its message so the tile behind draws the tombstone (RC-6); a feed reel has
     * no such record and passes nothing.
     */
    onMediaGone?: () => void;
    /** On a carousel page: the visible media (the viewer's, kept per post). 0 elsewhere. */
    mediaIndex?: number;
    /** Where a held horizontal drag has taken the carousel's strip, in px; 0 at rest. */
    mediaDragX?: number;
    /** A drag holds the strip: it follows the finger with no transition. */
    mediaDragging?: boolean;
    /** The carousel's arrow buttons (a pointer has no swipe): the previous or next media. */
    onMediaStep?: (step: 'media-prev' | 'media-next') => void;
  }

  let {
    post,
    authToken,
    active,
    preload,
    onLike,
    rail,
    onReady,
    onMediaGone,
    mediaIndex = 0,
    mediaDragX = 0,
    mediaDragging = false,
    onMediaStep,
  }: Props = $props();

  /**
   * The page this row is drawn as. A row the CanaReels rule does not cover (the server chose it,
   * or a conversation built it) is drawn as a reel - the page it was before photos joined - and
   * said once in the log below.
   */
  const page = $derived(fullScreenPageOf(post) ?? 'reel');
  /** The reader's own reaction on the post, which the rail's heart draws. */
  const readerReaction = $derived((rail && post.reactions?.[rail.readerId]) || null);

  let hearts = $state<DoubleTapHeart | undefined>();

  function likeOnDoubleTap(at: Point) {
    if (onLike?.()) hearts?.burst(at);
  }

  /** The reel's one video, the photo page's one picture, or a carousel's first media. */
  const media = $derived(fullScreenMediaOf(post));
  const video = $derived(page === 'reel' ? media : undefined);
  /**
   * The media the page draws, each with how it is drawn: a carousel's every picture and video, else
   * the page's one media (a reel's video, a photo page's picture).
   */
  const panes = $derived.by(() => {
    if (page === 'carousel') {
      return fullScreenMediaListOf(post).map((ref) => ({
        ref,
        kind: fullScreenMediaKindOf(ref) ?? ('photo' as const),
      }));
    }
    if (!media) return [];
    return [{ ref: media, kind: page === 'reel' ? ('video' as const) : ('photo' as const) }];
  });
  /** The visible media, clamped: a row whose media shrank (an edit) never points past its end. */
  const visibleIndex = $derived(Math.min(Math.max(mediaIndex, 0), Math.max(panes.length - 1, 0)));
  /** The visible media is a video: the rail carries its save and its sound. */
  const visibleIsVideo = $derived(panes[visibleIndex]?.kind === 'video');
  /**
   * The visible media of this page has SETTLED (its pane's `onReady`); it gates the strip's
   * neighbours' fetch the way the viewer's own settle gates the next page's. Cleared when the page
   * leaves the screen or another media becomes visible.
   */
  let settledMedia = $state<number | null>(null);
  $effect(() => {
    if (!active || settledMedia !== visibleIndex) settledMedia = null;
  });

  function onPaneReady(i: number) {
    if (i !== visibleIndex) return;
    settledMedia = i;
    onReady?.();
  }
  /** What the rail's save takes: the post, and on a carousel the visible media of it. */
  const saveable = $derived(page === 'carousel' ? { ...post, mediaIndex: visibleIndex } : post);
  /** The media's own shape when it was recorded, else the canonical frame. */
  const ratio = $derived(
    media?.width && media?.height ? media.width / media.height : REEL_FRAME_RATIO
  );
  const authorName = $derived(postAuthorName(post));
  const authorHref = $derived(postAuthorHref(post));
  /** As on the post card: "Anonyme" is the name, the author the reader was served is a small line. */
  const revealed = $derived(revealedPostAuthor(post));
  /** As on the post card: "Republie par X" beside the time (user, 2026-10-24). */
  const republished = $derived(
    republishedByText(post.republishedBy, post.repostedBy, post.repostedByMe === true)
  );

  /** The rail's reaction drawer is open: the tap-outside layer below is drawn. */
  let railDrawerOpen = $state(false);
  /** The caption unfolded in place ("Voir plus"); folded again when the reel leaves the screen. */
  let expanded = $state(false);
  let textEl = $state<HTMLDivElement | undefined>();
  /** Whether the folded text hides lines - measured, so a short caption shows no "Voir plus". */
  let overflows = $state(false);
  /** Whether the reel's frame reaches the screen bottom (`ReelFrame`): only then is the inset owed. */
  let frameReachesBottom = $state(true);

  /**
   * The room under the caption and the rail: the bottom safe-area inset when the frame reaches the
   * screen bottom, plus a rem that clears the player's progress line (a reel's is 32 px of touch
   * target, 2 px drawn, on that edge - no bar to leave room for since 2026-10-23).
   */
  const bottomPad = $derived(
    frameReachesBottom ? 'pb-[calc(var(--safe-area-inset-bottom,0px)+1rem)]' : 'pb-4'
  );
  /** The rail carries a reel's tools (save, sound) even when it carries no social action. */
  const showRail = $derived(!!rail || page === 'reel' || page === 'replay' || visibleIsVideo);

  function setExpanded(next: boolean) {
    console.debug(`[reel-viewer] caption ${next ? 'expanded' : 'folded'} on ${post.id}`);
    expanded = next;
  }

  $effect(() => {
    if (!active && expanded) expanded = false;
  });

  $effect(() => {
    if (!textEl || expanded) return;
    return watchClampOverflow(textEl, (value) => (overflows = value));
  });

  /**
   * A REEL ON SCREEN WITH NO VIDEO IS A ROW THE SERVER WOULD NEVER HAVE CREATED - a reel IS its one
   * video (`assertCreateKindShape`). The slide can only draw the poster, a play glyph nothing can
   * play, so the line accuses the data upstream: dev's copy of production emptied two reels' media
   * and the iPhone 12 reading of v1.2.9-alpha.4 read them as "reels 2 and 3 never play".
   * ONCE PER REEL for the page's life: a return to it, or a refetch that rebuilds the slide, says
   * nothing new about the same row.
   */
  $effect(() => {
    if (active && page === 'reel' && !video && !reportedWithoutVideo.has(post.id)) {
      reportedWithoutVideo.add(post.id);
      console.error(
        `[reel-viewer] reel ${post.id} carries no video - a reel is its one video, nothing can play`
      );
    }
  });

  /**
   * A ROW THE CANAREELS RULE KEEPS OUT, ON SCREEN, means the server's list and the client's reading
   * of one row (`full-screen-post-sql.ts` against `fullScreenPost.ts`) disagree - the line accuses that
   * seam. Once per row, as above.
   */
  $effect(() => {
    if (active && fullScreenPageOf(post) === null && !reportedOutOfRule.has(post.id)) {
      reportedOutOfRule.add(post.id);
      console.error(
        `[reel-viewer] post ${post.id} is neither a reel nor one picture or video - the server listed a row the client keeps out`
      );
    }
  });
</script>

<!-- THE SAVE IS IN THE RAIL, UNDER THE SEND, FOR EVERY REEL (user, 2026-10-09: public or not, the
     member's own or anybody's; moved from the player's bar 2026-10-23, the sound under it). It
     saves what the viewer holds - the ref with its key that the player itself decrypts - so nothing
     here asks the server who owns the reel. -->
{#snippet railTools()}
  {#if page === 'replay'}
    <ReelSaveButton reel={saveable} rail save={() => saveReplayFlow(post)} />
  {:else}
    <ReelSaveButton reel={saveable} rail />
  {/if}
{/snippet}

<!-- A DOUBLE TAP ON THE REEL LIKES IT (`doubleTapLike`), the letterbox bands included. Nothing is
     held: the first tap toggles the player's controls at once and the second toggles them back, so
     the pair leaves them as they were. Not on a control - the player's bar, its play button, the
     caption's toggle and backdrop, the author link - which acts at once as before. Only the reel on
     screen listens. -->
<div
  class="relative h-full w-full overflow-hidden bg-black"
  data-reel-slide={post.id}
  use:doubleTapLike={{ onDoubleTap: likeOnDoubleTap, enabled: active && !!onLike }}
>
  <DoubleTapHeart bind:this={hearts} />
  <!-- THE SAME FRAME AS THE CAMERA, THE REVIEW AND THE EDITOR: what is published is what was framed,
       in the reel's own shape (a legacy reel was captured to a screen box, a gallery import has its
       own). The caption is INSIDE the frame, above the player's bar, so the two never overlap. -->
  <ReelFrame {ratio} bind:reachesBottom={frameReachesBottom} sourceKey={visibleIndex}>
    <!-- THE STRIP: one pane per media, side by side, moved as ONE transform - the visible media at
         rest, the finger's offset on top while a drag holds it. A page of one media is a strip of
         one that never moves. The transition is the viewer's snap; reduced motion makes it instant
         (the global rule in app.css), and nothing waits on its end. -->
    <div class="h-full w-full overflow-hidden" data-reel-page={page}>
      {#if page === 'replay'}
        <ReplayPane {post} {active} playerSafeBottom={frameReachesBottom} {onReady} />
      {:else if panes.length > 0}
        <div
          class="flex h-full w-full"
          style:transform={panes.length > 1
            ? `translate3d(calc(${-visibleIndex * 100}% + ${mediaDragX}px), 0, 0)`
            : undefined}
          style:transition={panes.length > 1 && !mediaDragging
            ? `transform ${GESTURE.SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
            : 'none'}
          data-reel-strip
        >
          {#each panes as pane, i (i)}
            {@const role =
              panes.length > 1
                ? carouselMediaRole(i, {
                    active,
                    preload,
                    settled: settledMedia === visibleIndex,
                    mediaIndex: visibleIndex,
                  })
                : { active, preload, show: true }}
            <!-- Only the media on show feeds the blurred backdrop (`ReelBackdrop`). -->
            <div
              class="h-full w-full shrink-0"
              data-reel-pane={i}
              data-backdrop-ignore={i === visibleIndex ? undefined : ''}
            >
              <ReelMediaPane
                postId={post.id}
                media={pane.ref}
                kind={pane.kind}
                {authToken}
                active={role.active}
                preload={role.preload}
                show={role.show}
                playerSafeBottom={frameReachesBottom}
                durationMs={page === 'reel' ? post.durationMs : null}
                onReady={() => onPaneReady(i)}
                {onMediaGone}
              />
            </div>
          {/each}
        </div>
      {:else}
        <div class="flex h-full w-full items-center justify-center"><VideoPoster /></div>
      {/if}
    </div>

    <!-- WHO PUBLISHED IT, AND WHAT THEY WROTE, BOTTOM-LEFT OVER A SCRIM (user, 2026-10-16, as on
         Instagram). Anchored to the bottom, so a longer text or 2x type grows UPWARD, above the
         player's bar. NEVER TALLER THAN THE FRAME: a letterboxed reel's frame can be shorter than
         half the screen, so the block is a column capped at the frame (`max-h-full`) and the text
         is the part that SHRINKS (`min-h-0`) and scrolls - the author row and the toggle stay.
         Above the tap-outside layer (`z-20` over its `z-10`). Pointer-transparent except the
         author link and the text controls, so a tap anywhere else still reaches the video.
         The bottom safe-area inset is paid ONLY when the frame reaches the screen bottom: a
         letterboxed frame sits well above the home indicator, and the inset there would leave the
         caption about one line. -->
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex max-h-full flex-col bg-linear-to-t from-black/80 via-black/50 to-transparent pl-4 text-white {showRail
        ? 'pr-16'
        : 'pr-4'} {expanded ? 'pt-4' : 'pt-16'} {bottomPad}"
      data-reel-caption
      data-reel-caption-inset={frameReachesBottom ? 'safe-area' : 'none'}
    >
      <div class="flex min-w-0 shrink-0 items-center gap-2">
        {#if authorHref}
          <!-- ONE NAME AND ONE BOX FOR ASSISTIVE TECH: the link is named by its `aria-label` and its
               content is hidden from the tree, so VoiceOver no longer reads a second "Avatar de"
               element inside it, and the link's frame is its own 44 px row rather than a rect
               unioned from its children (iPhone 12, v1.2.9-alpha.4: the frame read 242 x 869 pt
               around a 20 pt picture and a 23 pt name). -->
          <a
            href={authorHref}
            class="focus-visible:ring-accent-icon pointer-events-auto flex min-h-11 min-w-0 items-center gap-2 rounded-full pr-2 outline-none focus-visible:ring-2"
            aria-label={postAuthorLinkLabel(post)}
            data-reel-author
          >
            <span class="shrink-0" aria-hidden="true"><PostAuthorAvatar {post} size="sm" /></span>
            <span class="truncate text-sm font-bold" aria-hidden="true">{authorName}</span>
          </a>
        {:else}
          <span class="flex min-w-0 items-center gap-2" data-reel-author>
            <span class="shrink-0"><PostAuthorAvatar {post} size="sm" /></span>
            <span class="truncate text-sm font-bold">{authorName}</span>
          </span>
        {/if}
        <!-- The same age, from the same helper, as the post header's: the viewer has no header. And
             the same "Republie par X" beside it, which gives way BEFORE the name: the wrapper is
             `contents`, so the time, the dot and the icon are items of this row that never shrink,
             and the republishers are an item of basis 0 - they take only the room the name and the
             time leave, and truncate to nothing first. The name shrinks only when it alone and the
             time overflow the row. -->
        <span class="contents text-xs font-medium" data-reel-time-line>
          <span class="shrink-0 opacity-70" title={exactDate(post.createdAt)}
            >{timeAgo(post.createdAt)}</span
          >
          {#if post.studentsOnly}
            <StudentsOnlyChip onMedia />
          {/if}
          {#if republished}
            <span class="shrink-0 opacity-70" aria-hidden="true">&middot;</span>
            <Repeat2 size={12} strokeWidth={2.5} class="shrink-0 opacity-70" aria-hidden="true" />
            <span class="min-w-0 flex-1 basis-0 truncate opacity-70" data-reel-republished-by
              ><EmojiText text={republished} /></span
            >
          {/if}
        </span>
      </div>
      {#if revealed}
        <RevealedAuthorLine
          userId={revealed.userId}
          fallback={revealed.name}
          class="pointer-events-auto ml-8 shrink-0 text-white/80"
          tall
        />
      {/if}
      {#if post.markdown}
        <!-- EXPANDED, THE TEXT SCROLLS ITSELF, up to half the screen: `data-reel-caption-open` keeps
             the viewer's swipe off it, and `touch-pan-y` lets the engine scroll it.
             ITS LINKS AND MENTIONS ARE TAPPABLE, folded or not (owner, 2026-11-06: a post with a
             link is in CanaReels): the text is pointer-transparent, its `a` and `button` are not.
             They are the post card's own (`PostMarkdown` -> `PostMentionLink` -> `AppLink`, and
             the app's link handler with its Safe Browsing gate). A tap on one is never a double
             tap (`tapBelongsToInnerControl`) nor a swipe (no movement); a drag that starts on one
             still pages, as everywhere on the reel. A long URL wraps anywhere, never past the
             frame.
             THE TEXT IS ALWAYS ON THE VIEWER'S DARK SCRIM, whatever the app's theme: `data-theme="dark"`
             puts it in the `dark:` variant's scope (`app.css`), so its links, mentions and hashtags
             - and their hover - take the colours they were given for a dark surface, the post
             card's own. One attribute for every renderer, never a recolour per element. -->
        <div
          data-theme="dark"
          class="mt-1 min-h-0 {expanded
            ? 'pointer-events-auto max-h-[50dvh] touch-pan-y overflow-y-auto overscroll-contain'
            : 'shrink-0'}"
          data-reel-caption-open={expanded ? '' : undefined}
        >
          <PostMarkdown
            markdown={post.markdown}
            bind:element={textEl}
            class="text-sm leading-snug opacity-90 [&_a]:pointer-events-auto [&_a]:wrap-anywhere [&_button]:pointer-events-auto {expanded
              ? ''
              : 'line-clamp-2'}"
          />
        </div>
        {#if overflows || expanded}
          <button
            type="button"
            class="tap-target pointer-events-auto mt-1 shrink-0 self-start text-xs font-bold outline-none hover:underline focus-visible:underline"
            aria-expanded={expanded}
            onclick={() => setExpanded(!expanded)}
            data-reel-caption-toggle
          >
            {expanded ? m.post_voir_moins() : m.post_voir_plus()}
          </button>
        {/if}
      {/if}
    </div>

    {#if showRail}
      <!-- THE RAIL, BOTTOM-RIGHT, ON THE CAPTION'S BASELINE (Instagram's, measured on the Mi 9T:
           the column's centre ~30 dp from the edge, anchored to the bottom). Over the caption
           (`z-30`), which leaves it the room (`pr-16`). Out of the double tap (`data-no-double-tap`)
           and of the viewer's swipe (`data-reel-rail`, `NOT_A_GESTURE`). -->
      <div class="pointer-events-none absolute right-1 bottom-0 z-30 {bottomPad}">
        <ReelActionRail
          {readerReaction}
          reactionCount={reactionTotal(post.reactions, post.otherReactionCounts)}
          commentCount={commentCountOf(post)}
          onHeart={rail?.onHeart}
          onReact={rail?.onReact}
          onComments={post.canSeeComments === false ? undefined : rail?.onComments}
          onSend={rail?.onSend}
          tools={page === 'reel' || page === 'replay' || visibleIsVideo ? railTools : undefined}
          sound={page === 'reel' || page === 'replay' || visibleIsVideo}
          bind:drawerOpen={railDrawerOpen}
        />
      </div>
    {/if}
  </ReelFrame>

  {#if page === 'carousel' && panes.length > 1}
    <!-- WHERE THE READER IS IN THE CAROUSEL: one dot per media under the top bar, the visible one
         lit (Instagram's), named for assistive tech as "2 of 5". Pointer-transparent. -->
    <div
      class="pointer-events-none absolute inset-x-0 top-[calc(var(--safe-area-inset-top,0px)+1.25rem)] z-30 flex justify-center gap-1"
      role="img"
      aria-label={m.reels_carousel_position({ index: visibleIndex + 1, total: panes.length })}
      data-reel-carousel-dots
    >
      {#each panes as _pane, i (i)}
        <span
          class="size-1.5 rounded-full shadow-sm {i === visibleIndex ? 'bg-white' : 'bg-white/40'}"
          data-reel-carousel-dot={i === visibleIndex ? 'current' : ''}
        ></span>
      {/each}
    </div>
    {#if active && onMediaStep}
      <!-- A pointer has no swipe: the previous and next media are buttons on a wide screen, as the
           posts' are in the viewer's column. Buttons, so neither the swipe nor the double tap takes
           them (`NOT_A_GESTURE`, `tapBelongsToInnerControl`). -->
      {#if visibleIndex > 0}
        <button
          type="button"
          class="ui-icon-button focus-visible:ring-accent-icon absolute top-1/2 left-3 z-30 hidden -translate-y-1/2 rounded-full bg-white/15 text-white outline-none hover:bg-white/25 focus-visible:ring-2 md:flex"
          aria-label={m.reels_carousel_prev()}
          title={m.reels_carousel_prev()}
          onclick={() => onMediaStep('media-prev')}
          data-reel-carousel-prev
        >
          <ChevronLeft size={22} strokeWidth={2.5} />
        </button>
      {/if}
      {#if visibleIndex < panes.length - 1}
        <button
          type="button"
          class="ui-icon-button focus-visible:ring-accent-icon absolute top-1/2 right-16 z-30 hidden -translate-y-1/2 rounded-full bg-white/15 text-white outline-none hover:bg-white/25 focus-visible:ring-2 md:flex"
          aria-label={m.reels_carousel_next()}
          title={m.reels_carousel_next()}
          onclick={() => onMediaStep('media-next')}
          data-reel-carousel-next
        >
          <ChevronRight size={22} strokeWidth={2.5} />
        </button>
      {/if}
    {/if}
  {/if}

  {#if railDrawerOpen}
    <!-- TAP OUTSIDE RETRACTS THE REACTION DRAWER, AND ONLY THAT (owner, 2026-10-30). Here and not
         in the rail: `fixed` inside the viewer's transformed track is laid out against the track,
         so it covered the first slide's place and a later reel's tap went to the video. A button,
         so the viewer's swipe and the double tap leave it alone; above the caption (`z-20`), under
         the rail (`z-30`) whose drawer must stay tappable. -->
    <button
      type="button"
      class="absolute inset-0 z-25 cursor-default"
      tabindex="-1"
      aria-hidden="true"
      onclick={() => {
        console.debug('[reel-slide] tap outside the reaction drawer closes it');
        railDrawerOpen = false;
      }}
      data-reel-rail-drawer-dismiss
    ></button>
  {/if}

  {#if expanded}
    <!-- TAP OUTSIDE FOLDS THE TEXT - anywhere on the slide, the letterbox bands included, not only
         inside the frame. A button, so it is not a viewer gesture (`NOT_A_GESTURE`): a tap or a
         stray swipe on it neither pauses the video under it nor turns the reel. Hidden from
         assistive tech and out of the tab order: "Voir moins" is the named way back. Under the
         caption (`z-10` against its `z-20`). -->
    <button
      type="button"
      class="absolute inset-0 z-10 cursor-default"
      tabindex="-1"
      aria-hidden="true"
      onclick={() => setExpanded(false)}
      data-reel-caption-backdrop
    ></button>
  {/if}
</div>
