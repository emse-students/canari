import type { PostEntity } from '$lib/posts/api';
import type { ReelPageLoader } from './allReels';
import { mountedReelIndices } from './reelViewerNav';

/**
 * ONE LIST OF THE REEL VIEWER, AND EVERYTHING THAT IS TRUE ONLY OF IT: its reels, the one on screen,
 * how far its loader has been read, which page has settled, each carousel's visible media, where
 * the track and a held carousel drag stand, and which post's comments or share sheet is open. The viewer holds ONE as a `$derived` of its loader (`ReelViewer.svelte`), so a
 * new loader - the stream's order changed - is a new object in the same instant the prop changes:
 * nothing of the old list is ever read against the new one, and nothing has to be reset by an effect
 * that runs after the render (production, 1.6.10: that reset left a slide of the old list reading its
 * post at an index the new list does not have - [reels](docs/wiki/frontend/modules/reels.md)).
 *
 * A write that outlives its list - a page that lands, a track move that lands - goes to the object
 * it was started on, which nothing draws any more: identity, not a generation counter, says which
 * list a result belongs to.
 */
export class ReelList {
  /** The loader this list is read from; its identity IS the list's. */
  readonly loader: ReelPageLoader;
  reels = $state<PostEntity[]>([]);
  /** The reel on screen. */
  index = $state(0);
  /** How many rows the server has handed over so far - the next page's offset. */
  fetched = 0;
  hasMore = $state(true);
  loadingMore = false;
  /** The page on screen that has SETTLED (`ReelViewer`'s `markSettled`), by post id. */
  settledId = $state<string | null>(null);
  /** THE VISIBLE MEDIA OF EACH CAROUSEL, by post id. Absent means the first. */
  mediaIndexById = $state<Record<string, number>>({});
  /** Where the track is drawn from its rest, in px. */
  offsetX = $state(0);
  offsetY = $state(0);
  /** The track is moving towards a landing. */
  settling = $state(false);
  /** What runs once the track has landed. */
  afterSettle: (() => void) | null = null;
  /** Where a held horizontal drag has taken the current carousel's strip (`reelDragOffset`). */
  mediaDragX = $state(0);
  /** A drag is held: the strip follows the finger with no transition. */
  mediaDragging = $state(false);
  /** The post whose comments sheet is open, by id - the sheet follows the row, not an index. */
  commentsFor = $state<string | null>(null);
  /** The comments sheet has begun to slide out: the reel grows back to the screen with it. */
  commentsLeaving = $state(false);
  /** The post whose share sheet is open (the rail's send), by id. */
  shareFor = $state<string | null>(null);

  constructor(loader: ReelPageLoader, start: PostEntity, startMediaIndex = 0) {
    this.loader = loader;
    this.reels = [start];
    if (startMediaIndex > 0) this.mediaIndexById = { [start.id]: startMediaIndex };
  }
}

/** One mounted page of a list: its post and its place, bound together. */
export interface ReelSlot {
  post: PostEntity;
  i: number;
}

/**
 * THE PAGES MOUNTED AROUND THE ONE ON SCREEN, EACH CARRYING ITS OWN POST. A slide is handed the post
 * of its slot, never `reels[i]` read again later: a slide torn down after its list was replaced still
 * holds the post it was drawn for, where an index read against the new list finds nothing.
 */
export function mountedReelSlots(list: Pick<ReelList, 'reels' | 'index'>): ReelSlot[] {
  return mountedReelIndices(list.index, list.reels.length).map((i) => ({
    post: list.reels[i],
    i,
  }));
}
