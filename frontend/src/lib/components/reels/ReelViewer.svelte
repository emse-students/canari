<script lang="ts">
  /**
   * THE FULL-SCREEN VERTICAL REEL VIEWER (C7): the touched reel first, then the reels the server
   * lists, one per screen. Drag up for the next, down for the previous, right (or Back, or the X) to
   * close. The current reel plays with the app's one sound answer and loops; the next one preloads.
   *
   * Every decision - what a release means, where it leads, what is mounted, when the next page is
   * asked for - is `reels/reelViewerNav.ts`, on the media viewer's own gesture math. This file
   * measures the finger and moves ONE track: the reels sit one screen apart inside it, so a swipe is
   * a single transform whose own `transitionend` says when it has landed - never a timer.
   *
   * IT IS A HISTORY ENTRY (`bindHistoryOverlay`), so Android's Back closes it, and it covers the
   * screen (`coversScreen`), so the iOS native tab bar steps aside.
   *
   * THE RAIL AND THE COMMENTS SHEET (user, 2026-10-19, Instagram's Reels): each page of a post gets
   * the heart, the comments and the send (`ReelActionRail`); the comments open over the playing
   * reel (`ReelCommentsSheet`). A conversation's reel is not a post and gets neither - the rail is
   * drawn only for a signed-in reader (`likerId`). A dialog opened from in here (a report, the GIF
   * picker) is drawn above the viewer (`markViewerLayer`).
   *
   * A CAROUSEL PAGE (owner, 2026-11-06): vertical still pages POSTS, horizontal pages the MEDIA of
   * the post on screen (`reelViewerNav.ts` decides, `ReelSlide` draws the strip). The visible media
   * is kept PER POST for the viewer's life, so a swipe back up lands where the reader left that
   * post. The axis is locked on the first movement, for the finger and the mouse alike; the arrow
   * keys left and right and the slide's arrow buttons step the media too. A swipe right on its
   * first media springs back (Back and the X close). The settle that gates the next POST's preload
   * is the PAGE's: once its first visible media settled, a media swipe keeps it, so the next post's
   * download is never aborted and restarted by a swipe inside the strip.
   */
  import { onDestroy, onMount, untrack } from 'svelte';
  import { holdPlayback } from '$lib/actions/playWhileVisible';
  import { themeStore } from '$lib/stores/themeStore.svelte';
  import { ChevronDown, ChevronUp, X } from '@lucide/svelte';
  import ReelSlide from './ReelSlide.svelte';
  import ReelCommentsSheet from './ReelCommentsSheet.svelte';
  import { markViewerLayer } from '$lib/utils/viewerLayer';
  import { pickedReactionToggle, railHeartToggle, type ReelRailActions } from '$lib/reels/reelRail';
  import { WheelPageLock, wheelOverScrollable, wheelStep } from '$lib/reels/reelWheel';
  import { portal } from '$lib/actions/portal';
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import type { PostEntity } from '$lib/posts/api';
  import { ReelList, mountedReelSlots } from '$lib/reels/reelList.svelte';
  import { REEL_PAGE as PAGE, allReelsLoader, type ReelPageLoader } from '$lib/reels/allReels';
  import { REEL_ORDERS, type ReelOrder } from '$lib/reels/reelOrder';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import {
    mergeReelPage,
    reelDragOffset,
    reelReleaseVerdict,
    shouldLoadMoreReels,
    stepMediaIndex,
    stepReelIndex,
    type MediaPosition,
    type ReelSwipeVerdict,
  } from '$lib/reels/reelViewerNav';
  import { fullScreenMediaListOf, fullScreenPageOf } from '$lib/reels/fullScreenPost';
  import {
    GESTURE,
    classifyMove,
    releaseVelocity,
    type GestureKind,
    type Sample,
  } from '$lib/utils/viewerGestures';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { claimTouchMove } from '$lib/utils/touchClaim';
  import {
    DOUBLE_TAP_REACTION,
    publishPostReactions,
    reactionRefusedLocally,
    sendPostReaction,
    toggledReactions,
    type ServedReactions,
  } from '$lib/posts/postReaction';
  import { publishFailureMessage } from '$lib/posts/publishFailure';
  import { m } from '$lib/paraglide/messages';

  interface Props {
    /** The reel shown first: the one touched, or the newest when opened from the feed's icon. */
    startPost: PostEntity;
    authToken: string;
    onClose: () => void;
    /** The next page of reels: the C7 list (`reels/allReels.ts`) unless the opener has its own. */
    loadPage?: ReelPageLoader;
    /**
     * The signed-in reader, whose double tap on a reel likes it. Absent, a double tap does nothing:
     * a conversation's reel is not a post, and has no reactions to give.
     */
    likerId?: string;
    /**
     * Where the viewer grows from (the opening button's centre) when the View Transitions API is
     * absent: a transform-only entrance (`expandFrom`). Null: no entrance drawn here.
     */
    expandOrigin?: { x: number; y: number } | null;
    /**
     * A reel's file answered `410` (`ReelSlide`'s `onMediaGone`), named by its post id. A
     * conversation's opener records it on the message so the tile behind draws the tombstone
     * (RC-6, [reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md) 15.4); the feed passes
     * nothing.
     */
    onMediaGone?: (postId: string) => void;
    /**
     * On a carousel page, the media the viewer opens on: the one the reader TAPPED in the post's
     * grid (owner, 2026-11-10: a tap on a feed video opens full screen on THAT video). 0 elsewhere.
     */
    startMediaIndex?: number;
    /**
     * THE STREAM'S ORDER, "Pour toi" or "Récents" ("Nos principes", owner 2026-11-10: a chronological
     * view must always exist), drawn at the top - the CanaReels entry's stream only; an opener that
     * shows one post's media passes none. A change hands this viewer a new `loadPage` and
     * `startPost`, and the viewer starts over at the top of the new list.
     */
    orderChoice?: { value: ReelOrder; busy?: boolean; onChange: (order: ReelOrder) => void };
  }

  let {
    startPost,
    authToken,
    onClose,
    loadPage = allReelsLoader(),
    likerId,
    expandOrigin = null,
    onMediaGone,
    startMediaIndex = 0,
    orderChoice,
  }: Props = $props();

  /** The label of each order, in the order `REEL_ORDERS` lists them. */
  const REEL_ORDER_LABELS: Record<ReelOrder, () => string> = {
    ranked: m.reels_order_for_you,
    recent: m.reels_order_recent,
  };

  /**
   * Touches on these belong to them: the player's bar seeks, a button is pressed, and an EXPANDED
   * caption scrolls its own text (`ReelSlide`) - a swipe there must not turn the reel.
   */
  const NOT_A_GESTURE =
    'button, [data-video-controls], [data-reel-caption-open], [data-reel-rail], [data-comments-drawer]';

  markViewerLayer();

  // WHATEVER PLAYS BEHIND THE VIEWER STOPS WHEN IT OPENS, not when its first player mounts (owner,
  // 2026-11-06): held from the first line, released on destroy, which brings the feed's video back.
  const releasePlayback = holdPlayback('the reel viewer is open');
  onDestroy(releasePlayback);

  /**
   * THE LIST ON SCREEN, A `$derived` OF THE LOADER (`reels/reelList.svelte.ts`): a new loader - the
   * stream's order changed - IS a new list, in the same instant the prop changes, starting over at the
   * top with the post the opener hands (`startPost`, read once per list). Nothing of the old list is
   * reset by an effect after a render, and nothing outlives it: its reels, its place, its pages, its
   * settle, its carousels and its track move all go with the object.
   */
  /** How many lists this viewer has shown: the first is the opening, each later one a change of order. */
  let listCount = 0;
  const list = $derived.by(() => {
    const start = untrack(() => startPost);
    const next = new ReelList(
      loadPage,
      start,
      untrack(() => startMediaIndex)
    );
    listCount += 1;
    if (listCount > 1) console.debug(`[reel-viewer] a new list (${listCount}) from ${start.id}`);
    return next;
  });

  let frame = $state<HTMLDivElement | null>(null);

  /** Where a held horizontal drag has taken the current carousel's strip (`reelDragOffset`). */
  let mediaDragX = $state(0);
  /** A drag is held: the strip follows the finger with no transition. */
  let mediaDragging = $state(false);

  /** The media position of a page: its visible media out of how many (1 off a carousel). */
  function mediaPositionOf(post: PostEntity | undefined): MediaPosition {
    if (!post || fullScreenPageOf(post) !== 'carousel') return { index: 0, count: 1 };
    const count = fullScreenMediaListOf(post).length;
    return { index: Math.min(list.mediaIndexById[post.id] ?? 0, count - 1), count };
  }

  /**
   * What a settle is keyed on: the PAGE. A media swipe inside a settled page keeps it, so the next
   * post's preload is not aborted and restarted; the strip's own neighbours settle per media
   * (`ReelSlide`).
   */
  function settleKeyOf(post: PostEntity | undefined): string | null {
    return post ? post.id : null;
  }

  const overlay = bindHistoryOverlay(
    () => true,
    () => {
      console.debug('[reel-viewer] closed');
      onClose();
    }
  );

  onMount(() => {
    // The viewer paints black under the status bar: light icons while it is up, handed back after.
    const releaseBar = themeStore.holdNativeBar('dark');
    overlay.syncOpen();
    console.debug(`[reel-viewer] opened on ${startPost.id}`);
    return releaseBar;
  });

  /**
   * The pages mounted around the one on screen, EACH WITH ITS OWN POST (`mountedReelSlots`): a slide
   * is keyed by and handed its slot's post, so one torn down after its list was replaced still holds
   * the post it was drawn for.
   */
  const slots = $derived(mountedReelSlots(list));

  /**
   * THE REEL ON SCREEN THAT HAS SETTLED (`ReelSlide`'s `onReady`: whole and playing). The next
   * reel preloads only behind it, never beside it: on a weak link two downloads at once would
   * starve the one being watched. Every step CLEARS it (where `index` moves), so a return to a reel that
   * settled on an earlier visit withholds the preload until it settles again; and only the slide
   * on screen may set it (`onReady` checks its post), never one torn down mid-swipe.
   */
  const currentSettled = $derived(
    list.settledId !== null && list.settledId === settleKeyOf(list.reels[list.index])
  );

  function markSettled(post: PostEntity) {
    if (post.id !== settleKeyOf(list.reels[list.index])) {
      console.debug(`[reel-viewer] ${post.id} settled off screen - ignored`);
      return;
    }
    list.settledId = settleKeyOf(post);
  }

  // The next page, asked for as the reader nears the end of what is loaded.
  $effect(() => {
    const current = list;
    if (
      !shouldLoadMoreReels(current.index, current.reels.length, current.hasMore) ||
      current.loadingMore ||
      current.reels.length === 0
    ) {
      return;
    }
    void loadMore(current);
  });

  /**
   * Reads the next page of `target`, into `target`: a page asked of a list that has since been
   * replaced lands in the object nobody draws any more, and is said, never mixed into the new one.
   */
  async function loadMore(target: ReelList) {
    target.loadingMore = true;
    try {
      const page = await target.loader(target.fetched, PAGE);
      if (target !== list) {
        console.debug('[reel-viewer] a page of the previous list landed - dropped');
        return;
      }
      target.fetched += page.length;
      if (page.length < PAGE) target.hasMore = false;
      target.reels = mergeReelPage(target.reels, page);
      console.debug(`[reel-viewer] page of ${page.length}, ${target.reels.length} loaded`);
    } catch (err) {
      if (target !== list) {
        console.debug('[reel-viewer] a page of the previous list failed - its list is gone', err);
        return;
      }
      // The reels already loaded stay watchable; the list simply ends here.
      console.error('[reel-viewer] the next reels could not be loaded', err);
      target.hasMore = false;
      showToast(m.reels_viewer_load_error(), 'error');
    } finally {
      target.loadingMore = false;
    }
  }

  /** Replaces the reactions of the loaded reel `postId`, wherever it now sits in the list. */
  function setReactions(postId: string, served: ServedReactions) {
    list.reels = list.reels.map((r) => (r.id === postId ? { ...r, ...served } : r));
  }

  /**
   * The posts whose reaction is on its way to the server. ONE AT A TIME PER POST: a second tap
   * while the first is in flight is ignored (logged), so two answers can never land out of order,
   * and a failure rolls back to the state the tap started from, which no later tap has moved.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a guard read by handlers, never rendered
  const reactionInFlight = new Set<string>();

  /**
   * Sends the reader's reaction `type` on `post` (taking it back when `wasReacted`) on the card's
   * path (`posts/postReaction.ts`): written on the tap, the server's answer adopted and announced to
   * the cards behind, a failure rolled back and said as the card's sentence in a toast.
   */
  function sendReaction(post: PostEntity, me: string, type: string, wasReacted: boolean) {
    const before = post.reactions ?? {};
    reactionInFlight.add(post.id);
    const tally = post.otherReactionCounts;
    setReactions(post.id, {
      reactions: toggledReactions(before, me, type).next,
      otherReactionCounts: tally,
    });
    sendPostReaction(post.id, type, wasReacted)
      .then(
        (served) => {
          setReactions(post.id, served);
          publishPostReactions(post.id, served);
        },
        (err: unknown) => {
          console.warn(`[reel-viewer] the reaction on ${post.id} was not recorded`, err);
          setReactions(post.id, { reactions: before, otherReactionCounts: tally });
          showToast(publishFailureMessage(err, m.post_reaction_error()), 'error');
        }
      )
      .finally(() => reactionInFlight.delete(post.id));
  }

  /**
   * A DOUBLE TAP ON A REEL LIKES IT, AND NEVER UNLIKES IT (user, 2026-10-19), on `sendReaction`.
   * A reel the reader already reacted to, with any reaction, gets the heart and no request. True
   * when the reel now carries the reader's reaction, which is when the heart is drawn.
   */
  function likeReel(post: PostEntity): boolean {
    const me = likerId;
    if (!me) return false;
    if ((post.reactions ?? {})[me]) {
      console.debug(`[reel-viewer] double tap on ${post.id}: already reacted, heart only`);
      return true;
    }
    if (reactionInFlight.has(post.id)) {
      console.debug(`[reel-viewer] double tap on ${post.id}: a reaction is in flight, ignored`);
      return false;
    }
    if (reactionRefusedLocally()) {
      console.debug(`[reel-viewer] double tap on ${post.id}: refused, the reader is muted`);
      showToast(m.post_action_not_allowed(), 'error');
      return false;
    }
    console.debug(`[reel-viewer] double tap on ${post.id}: like`);
    sendReaction(post, me, DOUBLE_TAP_REACTION, false);
    return true;
  }

  /**
   * THE RAIL'S HEART (`reels/reelRail.ts`): it takes the reader's reaction back if they hold one,
   * and gives "J'aime" if not - the card's toggle, on `sendReaction`.
   */
  function toggleHeart(post: PostEntity) {
    const me = likerId;
    if (!me) return;
    if (reactionInFlight.has(post.id)) {
      console.debug(`[reel-viewer] heart on ${post.id}: a reaction is in flight, ignored`);
      return;
    }
    if (reactionRefusedLocally()) {
      console.debug(`[reel-viewer] heart on ${post.id}: refused, the reader is muted`);
      showToast(m.post_action_not_allowed(), 'error');
      return;
    }
    const { type, wasReacted } = railHeartToggle(post.reactions ?? {}, me);
    console.debug(`[reel-viewer] heart on ${post.id}: ${wasReacted ? 'take back' : 'like'}`);
    sendReaction(post, me, type, wasReacted);
  }

  /**
   * A PICK IN THE HEART'S DRAWER (long press): the card's picker - a kind the reader does not hold
   * replaces theirs, the one they hold is taken back. Same guards as the heart.
   */
  function pickReaction(post: PostEntity, type: string) {
    const me = likerId;
    if (!me) return;
    if (reactionInFlight.has(post.id)) {
      console.debug(`[reel-viewer] drawer pick on ${post.id}: a reaction is in flight, ignored`);
      return;
    }
    if (reactionRefusedLocally()) {
      console.debug(`[reel-viewer] drawer pick on ${post.id}: refused, the reader is muted`);
      showToast(m.post_action_not_allowed(), 'error');
      return;
    }
    const pick = pickedReactionToggle(post.reactions ?? {}, me, type);
    console.debug(`[reel-viewer] drawer pick ${type} on ${post.id}`);
    sendReaction(post, me, pick.type, pick.wasReacted);
  }

  /** The post whose comments sheet is open, by id - the sheet follows the row, not an index. */
  let commentsFor = $state<string | null>(null);
  /** The sheet has begun to slide out: the reel grows back to the screen with it. */
  let commentsLeaving = $state(false);
  /** The reel is a rounded card above the sheet (Instagram's): `scale` of the full screen. */
  const commentsCard = $derived(commentsFor !== null && !commentsLeaving);
  const commentsPost = $derived(
    commentsFor ? (list.reels.find((r) => r.id === commentsFor) ?? null) : null
  );

  /**
   * The post whose share sheet is open (the rail's send), by id. The sheet (`PostShareSheet`) is
   * loaded on the first send, never with the viewer: it reads the conversation list, which a
   * viewer opened only to watch has no reason to load. Drawn inside the viewer, so its dialogs
   * take the viewer's rung (`markViewerLayer`).
   */
  let shareFor = $state<string | null>(null);
  let ShareSheet = $state<
    typeof import('$lib/components/posts/PostShareSheet.svelte').default | null
  >(null);

  function openShareSheet(postId: string) {
    import('$lib/components/posts/PostShareSheet.svelte')
      .then((mod) => {
        ShareSheet = mod.default;
        shareFor = postId;
      })
      .catch((e: unknown) => console.error('[reel-viewer] the share sheet did not load', e));
  }

  /** Replaces the loaded post `next.id` - a comment written in the sheet. */
  function setPost(next: PostEntity) {
    list.reels = list.reels.map((r) => (r.id === next.id ? next : r));
  }

  /** The rail's actions for one page, or none outside a signed-in reader's posts. */
  function railFor(post: PostEntity): ReelRailActions | undefined {
    const me = likerId;
    if (!me) return undefined;
    return {
      readerId: me,
      onHeart: () => toggleHeart(post),
      onReact: (type) => pickReaction(post, type),
      onComments: () => {
        console.debug(`[reel-viewer] comments opened on ${post.id}`);
        commentsLeaving = false;
        commentsFor = post.id;
      },
      onSend: () => openShareSheet(post.id),
    };
  }

  function reducedMotion(): boolean {
    return (
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /**
   * Moves the track to the given offset with the snap transition, then runs `then` once it has
   * landed. A move that changes nothing, or a reader who asked for reduced motion, runs `then` at
   * once - a transition that does not happen fires no end event.
   */
  function settle(x: number, y: number, then?: () => void) {
    // A LANDING IS NEVER DROPPED: a move started over one still pending (every entry point waits for
    // `settling` to clear, so this is a defect upstream) runs it first, and says so.
    if (list.afterSettle) {
      console.error('[reel-viewer] a move started over a pending landing - the landing runs first');
      const pending = list.afterSettle;
      list.afterSettle = null;
      pending();
    }
    if (reducedMotion() || (x === list.offsetX && y === list.offsetY)) {
      list.offsetX = x;
      list.offsetY = y;
      list.settling = false;
      list.afterSettle = null;
      then?.();
      return;
    }
    list.settling = true;
    list.afterSettle = then ?? null;
    list.offsetX = x;
    list.offsetY = y;
  }

  /**
   * The track's move is over: it ENDED, or it was CANCELLED (the track hidden or detached mid-move,
   * where `transitionend` never comes - and `settling` would freeze touch, keys, wheel and
   * chevrons until the viewer closed). Either way the landing runs, which puts the page at rest
   * where the move was going.
   */
  function onTransitionEnd(e: TransitionEvent) {
    if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
    if (e.type === 'transitioncancel') {
      console.warn('[reel-viewer] the track move was cancelled - landing where it was going');
    }
    list.settling = false;
    const next = list.afterSettle;
    list.afterSettle = null;
    next?.();
  }

  /**
   * Steps the current carousel to its previous or next media. Nothing waits on a landing: the strip
   * moves by its own transition from where the finger left it, the index moves at once, so the
   * media that leaves unmounts its player at once (only the visible media plays).
   */
  function stepMedia(verdict: 'media-next' | 'media-prev') {
    const post = list.reels[list.index];
    const at = mediaPositionOf(post);
    const target = stepMediaIndex(at.index, verdict, at.count);
    mediaDragging = false;
    mediaDragX = 0;
    if (!post || target === at.index) return;
    console.debug(`[reel-viewer] ${verdict} on ${post.id}: ${at.index} -> ${target}`);
    // The page's settle is kept: the next post's preload goes on behind the strip.
    list.mediaIndexById = { ...list.mediaIndexById, [post.id]: target };
  }

  /** Carries out a verdict: the track leaves towards it, then the index moves and the track rests. */
  function go(verdict: ReelSwipeVerdict) {
    if (verdict === 'media-next' || verdict === 'media-prev') {
      stepMedia(verdict);
      return;
    }
    mediaDragging = false;
    mediaDragX = 0;
    const height = frame?.clientHeight ?? window.innerHeight;
    const width = frame?.clientWidth ?? window.innerWidth;
    const target = stepReelIndex(list.index, verdict, list.reels.length);
    if (verdict === 'close') {
      console.debug('[reel-viewer] closed by a swipe');
      settle(width, 0, () => overlay.dismissFromUi());
      return;
    }
    if (target === list.index) {
      settle(0, 0);
      return;
    }
    console.debug(`[reel-viewer] ${verdict}: ${list.index} -> ${target}`);
    // The landing belongs to the list the move started on: a list replaced meanwhile keeps its own.
    const moved = list;
    settle(0, verdict === 'next' ? -height : height, () => {
      // The track has landed one screen away; moving the index there is the same picture at rest.
      moved.settling = false;
      // The reel landed on has not settled IN THIS VISIT, whatever it did before.
      moved.settledId = null;
      moved.index = target;
      moved.offsetY = 0;
    });
  }

  let viewerEl = $state<HTMLDivElement | null>(null);

  /**
   * THE MOUSE WHEEL TURNS THE PAGE (user, 2026-10-19, desktop): one gesture, one page, through
   * `go` - the arrow buttons' path (`reels/reelWheel.ts`). Not while the comments sheet is open nor
   * over a child that scrolls (the list scrolls instead), never on ctrl+wheel (zoom) or a horizontal
   * scroll. Non-passive, on the viewer only, so `preventDefault` runs exactly when the event is
   * consumed; removed with the viewer.
   */
  $effect(() => {
    const el = viewerEl;
    if (!el) return;
    const lock = new WheelPageLock();
    function onWheel(e: WheelEvent) {
      const step = wheelStep(e);
      if (!step || commentsFor || shareFor || wheelOverScrollable(e.target, el!)) return;
      e.preventDefault();
      // Free when the wheel was quiet AND the last page has landed (`settling` clears on landing).
      const free = lock.free && !list.settling;
      lock.heard();
      if (!free) return;
      console.debug(`[reel-viewer] wheel: ${step}`);
      go(step);
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      lock.dispose();
    };
  });

  // Touch listeners by hand with `passive: false`: Svelte registers touch handlers as passive, where
  // `preventDefault()` is ignored and the page would scroll under the drag. THE MOUSE DRIVES THE SAME
  // GESTURE (owner, 2026-11-06: a carousel is dragged on a desktop too) through pointer events of
  // type `mouse` - a touch or a pen keeps the touch path, so nothing is read twice.
  $effect(() => {
    const el = frame;
    if (!el) return;
    let gesture: GestureKind | null = null;
    let start: Sample = { x: 0, y: 0, t: 0 };
    let samples: Sample[] = [];
    /** A mouse drag that moved the page: the click it ends with is not a tap. */
    let swallowClick = false;
    const sampleOf = (t: Touch, time: number): Sample => ({ x: t.clientX, y: t.clientY, t: time });

    /** A press: whether it starts a gesture of ours. */
    function begin(target: EventTarget | null, at: Sample, pointers: number) {
      if ((target as HTMLElement | null)?.closest?.(NOT_A_GESTURE) || list.settling) {
        gesture = null;
        return;
      }
      gesture = pointers >= 2 ? 'pinch' : 'pending';
      start = at;
      samples = [start];
    }

    /**
     * A move. `claim` takes it from the engine and says whether it could (a touch the engine is
     * already scrolling cannot be claimed). False when the move is not ours.
     */
    function move(now: Sample, claim: () => boolean): boolean {
      if (!gesture || gesture === 'pinch') return false;
      samples.push(now);
      if (samples.length > 12) samples.shift();
      const dx = now.x - start.x;
      const dy = now.y - start.y;
      if (gesture === 'pending') {
        // Classified ONCE, then kept until the finger lifts: a swipe that curves stays a swipe.
        gesture = classifyMove({ dx, dy, zoomed: false, touches: 1 });
        if (gesture === 'pending') return false;
        console.debug(`[reel-viewer] drag locked to ${gesture}`);
      }
      // A move the engine is already scrolling is not ours: the drag stands down and springs back.
      if (!claim()) {
        gesture = null;
        mediaDragging = false;
        mediaDragX = 0;
        settle(0, 0);
        return false;
      }
      const o = reelDragOffset(
        gesture,
        dx,
        dy,
        list.index > 0,
        list.index < list.reels.length - 1,
        mediaPositionOf(list.reels[list.index])
      );
      list.offsetX = o.x;
      list.offsetY = o.y;
      mediaDragging = true;
      mediaDragX = o.mediaX;
      return true;
    }

    /** A release: what the drag meant. */
    function end(at: Sample) {
      const kind = gesture;
      gesture = null;
      if (!kind || kind === 'pending' || kind === 'pinch') return;
      samples.push(at);
      go(
        reelReleaseVerdict({
          kind,
          dx: at.x - start.x,
          dy: at.y - start.y,
          velocity: releaseVelocity(samples),
          width: el!.clientWidth,
          height: el!.clientHeight,
          hasPrevious: list.index > 0,
          hasNext: list.index < list.reels.length - 1,
          media: mediaPositionOf(list.reels[list.index]),
        })
      );
    }

    // A cancel ends a drag of OURS; one arriving while a page lands (no drag was taken) moves nothing.
    function cancel() {
      if (!gesture) return;
      gesture = null;
      mediaDragging = false;
      mediaDragX = 0;
      settle(0, 0);
    }

    function onStart(e: TouchEvent) {
      begin(e.target, sampleOf(e.touches[0], e.timeStamp), e.touches.length);
    }

    function onMove(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      move(sampleOf(e.touches[0], e.timeStamp), () => claimTouchMove(e));
    }

    function onEnd(e: TouchEvent) {
      if (!gesture || e.touches.length > 0) return;
      end(sampleOf(e.changedTouches[0], e.timeStamp));
    }

    const pointSample = (e: PointerEvent): Sample => ({
      x: e.clientX,
      y: e.clientY,
      t: e.timeStamp,
    });

    function onPointerDown(e: PointerEvent) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      swallowClick = false;
      begin(e.target, pointSample(e), 1);
    }

    function onPointerMove(e: PointerEvent) {
      if (e.pointerType !== 'mouse' || !gesture) return;
      if (e.buttons === 0) {
        // The button is up and no pointerup came (a context menu opened mid-drag): the drag is over.
        console.debug('[reel-viewer] a mouse drag lost its pointerup - cancelled');
        swallowClick = false;
        cancel();
        return;
      }
      if (
        move(pointSample(e), () => {
          // A mouse drag is ours once it moved past the slop: no text selection, no image drag.
          e.preventDefault();
          return true;
        })
      ) {
        swallowClick = true;
      }
    }

    function onPointerUp(e: PointerEvent) {
      if (e.pointerType !== 'mouse' || !gesture) return;
      end(pointSample(e));
      // The click this pointerup makes is dispatched in the same task; a drag that ends outside
      // the frame makes none, so the flag must not outlive this frame and eat a later real tap.
      if (swallowClick) requestAnimationFrame(() => (swallowClick = false));
    }

    /**
     * THE CLICK THAT ENDS A MOUSE DRAG IS NOT A TAP: it would pause the video under it and count
     * towards a double tap's like - and, ending on a caption's LINK (owner, 2026-11-06: a post with
     * a link is in CanaReels), it would open it. Taken in the capture phase of the WINDOW, before
     * the document's link handler (`installAppLinkClickHandler`, which leaves a prevented click
     * alone), the slide's double tap and the player see it; only a click inside the viewer.
     */
    function onClickCapture(e: MouseEvent) {
      if (!swallowClick || !(e.target instanceof Node) || !el!.contains(e.target)) return;
      swallowClick = false;
      console.debug('[reel-viewer] the click ending a mouse drag is not a tap - swallowed');
      e.preventDefault();
      e.stopPropagation();
    }

    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: false });
    el.addEventListener('touchcancel', cancel);
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('click', onClickCapture, { capture: true });
    // A picture's native drag would steal the mouse's pointer events (`pointercancel`).
    const noNativeDrag = (e: DragEvent) => e.preventDefault();
    el.addEventListener('dragstart', noNativeDrag);
    return () => {
      el.removeEventListener('dragstart', noNativeDrag);
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', cancel);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('click', onClickCapture, { capture: true });
    };
  });

  /** How far one arrow key scrolls an unfolded caption: about two lines of its text. */
  const CAPTION_LINE_STEP = 40;

  /**
   * While the current reel's caption is UNFOLDED (`ReelSlide`, `data-reel-caption-open`), the up and
   * down keys scroll ITS text, as a drag there does, instead of turning the reel. True when it took
   * the key.
   */
  function scrollOpenCaption(e: KeyboardEvent): boolean {
    const down = e.key === 'ArrowDown' || e.key === 'PageDown';
    const up = e.key === 'ArrowUp' || e.key === 'PageUp';
    if (!down && !up) return false;
    const caption = frame?.querySelector<HTMLElement>('[data-reel-caption-open]');
    if (!caption) return false;
    e.preventDefault();
    const step = e.key.startsWith('Page') ? caption.clientHeight * 0.9 : CAPTION_LINE_STEP;
    caption.scrollBy({ top: down ? step : -step });
    return true;
  }

  /** The page on screen is a carousel: the left and right keys step its media. */
  const carouselOnScreen = $derived(mediaPositionOf(list.reels[list.index]).count > 1);

  /** The keyboard: up/down page, left/right a carousel's media, Escape closes. A key the player already used is left to it. */
  function onKeydown(e: KeyboardEvent) {
    // The comments sheet has the keyboard while it is open: its field types, and Escape closes IT.
    if (e.defaultPrevented || list.settling || commentsFor || shareFor) return;
    if (scrollOpenCaption(e)) return;
    if (e.key === 'ArrowDown' || e.key === 'PageDown') {
      e.preventDefault();
      go('next');
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault();
      go('prev');
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && carouselOnScreen) {
      // A carousel's media, left and right: the swipe's own step. Off a carousel the keys are free.
      e.preventDefault();
      go(e.key === 'ArrowRight' ? 'media-next' : 'media-prev');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      overlay.dismissFromUi();
    }
  }

  /**
   * THE VIEWER'S BOUNDARY CAUGHT A THROW (a slide, a sheet, the rail): a defect of this viewer, said
   * as one with the post on screen, then the viewer closes - the feed behind it stays as it was.
   */
  function closeOnCrash(error: unknown) {
    console.error(
      `[reel-viewer] the viewer failed on ${list.reels[list.index]?.id ?? '?'} - closed, the page behind it kept:`,
      error
    );
    showToast(m.reels_viewer_crashed(), 'error');
    overlay.dismissFromUi();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- AN ERROR INSIDE THE VIEWER CLOSES THE VIEWER, NOT THE PAGE BEHIND IT (production, 1.6.10: a slide's
     throw reached the route's boundary and took the whole feed down). A visible feature inside a page
     takes its own boundary (architecture.md, "boundaries are placed by blast radius"): the line
     accuses, the reader is told, and the viewer closes through its history entry - nothing is drawn
     in its place, the feed under it never left. -->
<svelte:boundary onerror={closeOnCrash}>
  <div use:portal>
    <div
      bind:this={viewerEl}
      use:coversScreen
      class="fixed inset-0 z-(--z-viewer) overflow-hidden bg-black text-white {expandOrigin
        ? 'motion-expand-in'
        : ''}"
      style:transform-origin={expandOrigin ? `${expandOrigin.x}px ${expandOrigin.y}px` : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={m.reels_viewer_label()}
      data-reel-viewer
    >
      <!-- THE REEL SHRINKS INTO A CARD while the comments are open (transform only, the motion scale of
         design-reference "Motion"; the global reduced-motion rule makes it instant). The corner radius is
         set at once, not animated, and is drawn at the card's scale, so it reads about 12 px. -->
      <div
        bind:this={frame}
        class="absolute inset-0 touch-none {commentsCard ? 'overflow-hidden rounded-3xl' : ''}"
        style:transform-origin="50% 0"
        style:transform={commentsCard
          ? 'translate3d(0, calc(var(--safe-area-inset-top, 0px) + 0.75rem), 0) scale(0.34)'
          : 'none'}
        style:transition="transform var(--motion-slow) var(--motion-ease-out)"
        data-reel-card={commentsCard}
      >
        <div
          class="absolute inset-0"
          style:transform="translate3d({list.offsetX}px, calc({-list.index * 100}% + {list.offsetY}px),
          0)"
          style:transition={list.settling
            ? `transform ${GESTURE.SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1)`
            : 'none'}
          ontransitionend={onTransitionEnd}
          ontransitioncancel={onTransitionEnd}
          data-reel-track
        >
          <!-- Each slide is keyed by and HANDED its slot's post, never `reels[i]` read again: a slide
             torn down after a change of order still reads the post it was drawn for. -->
          {#each slots as slot (slot.post.id)}
            <div class="absolute inset-x-0 h-full" style:top="{slot.i * 100}%">
              <ReelSlide
                post={slot.post}
                {authToken}
                active={slot.i === list.index}
                preload={slot.i === list.index + 1 && currentSettled}
                onReady={() => markSettled(slot.post)}
                onMediaGone={onMediaGone ? () => onMediaGone(slot.post.id) : undefined}
                onLike={likerId ? () => likeReel(slot.post) : undefined}
                rail={railFor(slot.post)}
                mediaIndex={mediaPositionOf(slot.post).index}
                mediaDragX={slot.i === list.index ? mediaDragX : 0}
                mediaDragging={slot.i === list.index && mediaDragging}
                onMediaStep={(step) => !list.settling && slot.i === list.index && go(step)}
              />
            </div>
          {/each}
        </div>
      </div>

      <!-- THE TOP SCRIM (user, 2026-10-23: the status bar icons vanished on black) lies under the
         close button and the phone's status bar, so white icons read on a bright reel too; the
         native icons themselves are held light (`holdNativeBar`). The X has no disc: a disc
         against a letterboxed frame's rounded corner read as overlapping it. Safe-area aware. -->
      <div
        class="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-linear-to-b from-black/50 to-transparent px-2 pt-[calc(var(--safe-area-inset-top,0px)+0.5rem)] pb-6"
        data-reel-top-scrim
      >
        <button
          type="button"
          class="ui-icon-button focus-visible:ring-accent-icon pointer-events-auto rounded-full outline-none focus-visible:ring-2"
          aria-label={m.reels_viewer_close()}
          title={m.reels_viewer_close()}
          onclick={() => overlay.dismissFromUi()}
        >
          <X size={26} strokeWidth={2.5} class="drop-shadow-md" />
        </button>
        {#if orderChoice}
          <!-- "Pour toi" / "Récents" (owner, 2026-11-10; restyled 2026-11-11 as TikTok and Instagram
             draw it): bare white tabs on the video, the selected one brighter and underlined, a
             text shadow keeping both readable on a bright reel. The empty box after it balances the X. -->
          <div class="pointer-events-auto {orderChoice.busy ? 'opacity-70' : ''}" data-reel-order>
            <SegmentedControl
              items={REEL_ORDERS.map((key) => ({ key, label: REEL_ORDER_LABELS[key]() }))}
              value={orderChoice.value}
              onSelect={(key) => orderChoice.onChange(key)}
              label={m.reels_order_label()}
              variant="overlay"
              activation="manual"
              class="w-56"
            />
          </div>
          <span class="w-11 shrink-0" aria-hidden="true"></span>
        {/if}
      </div>

      <!-- A pointer has no swipe: the two steps are buttons on a wide screen. -->
      <div
        class="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 flex-col gap-2 md:flex"
      >
        <button
          type="button"
          class="ui-icon-button focus-visible:ring-accent-icon pointer-events-auto rounded-full bg-white/15 outline-none hover:bg-white/25 focus-visible:ring-2 disabled:opacity-30"
          aria-label={m.reels_viewer_prev()}
          title={m.reels_viewer_prev()}
          disabled={list.index === 0}
          onclick={() => !list.settling && go('prev')}
        >
          <ChevronUp size={22} strokeWidth={2.5} />
        </button>
        <button
          type="button"
          class="ui-icon-button focus-visible:ring-accent-icon pointer-events-auto rounded-full bg-white/15 outline-none hover:bg-white/25 focus-visible:ring-2 disabled:opacity-30"
          aria-label={m.reels_viewer_next()}
          title={m.reels_viewer_next()}
          disabled={list.index >= list.reels.length - 1}
          onclick={() => !list.settling && go('next')}
        >
          <ChevronDown size={22} strokeWidth={2.5} />
        </button>
      </div>

      {#if commentsPost && likerId}
        <ReelCommentsSheet
          post={commentsPost}
          currentUserId={likerId}
          {authToken}
          onChange={setPost}
          onClosing={() => (commentsLeaving = true)}
          onClose={() => {
            commentsFor = null;
            commentsLeaving = false;
          }}
        />
      {/if}

      {#if ShareSheet && shareFor}
        {@const sharedReel = list.reels.find((r) => r.id === shareFor)}
        <ShareSheet
          open
          postId={shareFor}
          onClose={() => (shareFor = null)}
          canRepost={sharedReel?.canRepost === true}
          repostedByMe={sharedReel?.repostedByMe === true}
          onRepostChange={(id, reposted) => {
            // WP-F6: the server's answer, written onto the reel so the next sheet offers the right row.
            const reel = list.reels.find((r) => r.id === id);
            if (reel) setPost({ ...reel, repostedByMe: reposted, canRepost: !reposted });
          }}
          onSentInApp={() => {
            // The link waits in a conversation's composer, under this viewer: step aside for it.
            console.debug('[reel-viewer] closed: the reel was sent into a conversation');
            overlay.dismissFromUi();
          }}
        />
      {/if}
    </div>
  </div>
</svelte:boundary>
