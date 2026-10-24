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
   * with `VideoPlayer`, its bar and the app's one sound answer. A neighbour draws Canari's poster
   * instead, because every mounted player counts as an open viewer and claims playback
   * (`followVideoSound`); the NEXT reel preloads its video meanwhile (`ReelPreload`), so its player
   * takes the warm path and shows the first frame the moment the swipe lands.
   *
   * THE SAVE BUTTON (`ReelSaveButton`) is in the player's bar next to the volume button, for every
   * reel (user, 2026-10-09: "public or not"). Nothing here claims the video is protected.
   *
   * A POST OF ONE PICTURE IS A PAGE TOO (user, 2026-10-19, as Instagram's Reels mix them): the
   * same frame, overlay and rail, its picture in place of the video and no player bar
   * (`reels/fullScreenPost.ts` says which page a row is). THE RAIL (`ReelActionRail`) is drawn
   * when the viewer hands its actions over - a post's reel, never a conversation's.
   */
  import PostMedia from '$lib/components/posts/PostMedia.svelte';
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
  import { Repeat2 } from '@lucide/svelte';
  import { REEL_FRAME_RATIO } from '$lib/reels/reelFrame';
  import { ReelPreload } from '$lib/reels/reelPreload';
  import { watchClampOverflow } from '$lib/utils/posts/clampOverflow';
  import { exactDate, timeAgo } from '$lib/utils/time';
  import { m } from '$lib/paraglide/messages';
  import ReelFrame from './ReelFrame.svelte';
  import ReelSaveButton from './ReelSaveButton.svelte';
  import DoubleTapHeart from '$lib/components/posts/DoubleTapHeart.svelte';
  import { doubleTapLike } from '$lib/actions/doubleTapLike';
  import type { Point } from '$lib/utils/viewerGestures';
  import ReelActionRail from './ReelActionRail.svelte';
  import { fullScreenMediaOf, fullScreenPageOf } from '$lib/reels/fullScreenPost';
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
  }

  let { post, authToken, active, preload, onLike, rail }: Props = $props();

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

  /** The reel's one video, or the photo page's one picture. */
  const media = $derived(fullScreenMediaOf(post));
  const video = $derived(page === 'reel' ? media : undefined);
  /** The media's own shape when it was recorded, else the canonical frame. */
  const ratio = $derived(
    media?.width && media?.height ? media.width / media.height : REEL_FRAME_RATIO
  );
  const authorName = $derived(postAuthorName(post));
  const authorHref = $derived(postAuthorHref(post));
  /** As on the post card: "Anonyme" is the name, the author the reader was served is a small line. */
  const revealed = $derived(revealedPostAuthor(post));
  /** As on the post card: "Republie par X" beside the time (user, 2026-10-24). */
  const republished = $derived(republishedByText(post.republishedBy));

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
  const showRail = $derived(!!rail || page === 'reel');

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
   * of one row (`single-photo-sql.ts` against `fullScreenPost.ts`) disagree - the line accuses that
   * seam. Once per row, as above.
   */
  $effect(() => {
    if (active && fullScreenPageOf(post) === null && !reportedOutOfRule.has(post.id)) {
      reportedOutOfRule.add(post.id);
      console.error(
        `[reel-viewer] post ${post.id} is neither a reel nor one picture - the server listed a row the client keeps out`
      );
    }
  });

  $effect(() => {
    if (!preload || active || !video || !authToken) return;
    const ahead = new ReelPreload(video);
    return () => ahead.stop();
  });
</script>

<!-- THE SAVE IS IN THE RAIL, UNDER THE SEND, FOR EVERY REEL (user, 2026-10-09: public or not, the
     member's own or anybody's; moved from the player's bar 2026-10-23, the sound under it). It
     saves what the viewer holds - the ref with its key that the player itself decrypts - so nothing
     here asks the server who owns the reel. -->
{#snippet railTools()}
  <ReelSaveButton reel={post} rail />
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
  <ReelFrame {ratio} bind:reachesBottom={frameReachesBottom}>
    <div class="flex h-full w-full items-center justify-center" data-reel-page={page}>
      {#if page === 'photo'}
        <!-- A picture has no player to claim playback, so the next page's mounts ahead too. -->
        {#if (active || preload) && media}
          <PostMedia {media} {authToken} galleryMode />
        {/if}
      {:else if active && video}
        <PostMedia
          media={video}
          {authToken}
          galleryMode
          minimalPlayer
          playerSafeBottom={frameReachesBottom}
        />
      {:else}
        <VideoPoster />
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
            class="pointer-events-auto flex min-h-11 min-w-0 items-center gap-2 rounded-full pr-2 outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
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
             the same "Republie par X" beside it, which shrinks before the name does. -->
        <span
          class="flex min-w-0 items-center gap-1 text-xs font-medium opacity-70"
          data-reel-time-line
        >
          <span class="shrink-0" title={exactDate(post.createdAt)}>{timeAgo(post.createdAt)}</span>
          {#if republished}
            <span class="shrink-0" aria-hidden="true">&middot;</span>
            <Repeat2 size={12} strokeWidth={2.5} class="shrink-0" />
            <span class="truncate" data-reel-republished-by>{republished}</span>
          {/if}
        </span>
      </div>
      {#if revealed}
        <RevealedAuthorLine
          userId={revealed.userId}
          fallback={revealed.name}
          class="pointer-events-auto ml-8 shrink-0 text-white/80"
        />
      {/if}
      {#if post.markdown}
        <!-- EXPANDED, THE TEXT SCROLLS ITSELF, up to half the screen: `data-reel-caption-open` keeps
             the viewer's swipe off it, and `touch-pan-y` lets the engine scroll it. -->
        <div
          class="mt-1 min-h-0 {expanded
            ? 'pointer-events-auto max-h-[50dvh] touch-pan-y overflow-y-auto overscroll-contain'
            : 'shrink-0'}"
          data-reel-caption-open={expanded ? '' : undefined}
        >
          <PostMarkdown
            markdown={post.markdown}
            bind:element={textEl}
            class="text-sm leading-snug opacity-90 {expanded ? '' : 'line-clamp-2'}"
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
          reactionCount={reactionTotal(post.reactions)}
          commentCount={commentCountOf(post)}
          onHeart={rail?.onHeart}
          onReact={rail?.onReact}
          onComments={rail?.onComments}
          onSend={rail?.onSend}
          tools={page === 'reel' ? railTools : undefined}
          sound={page === 'reel'}
        />
      </div>
    {/if}
  </ReelFrame>

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
