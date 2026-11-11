import type { PostEntity } from '$lib/posts/api';
import { showToast } from '$lib/stores/toast.svelte';
import { isTransportFailure } from '$lib/utils/transportFailure';
import { m } from '$lib/paraglide/messages';
import { allReelsLoader, listAllReels, type ReelPageLoader } from './allReels';
import {
  DEFAULT_REEL_ORDER,
  preferredReelOrder,
  rememberReelOrder,
  type ReelOrder,
} from './reelOrder';

/** What the viewer draws at its top to switch the order (`ReelViewer`'s `orderChoice`). */
export interface ReelOrderChoice {
  value: ReelOrder;
  busy?: boolean;
  onChange: (order: ReelOrder) => void;
}

/**
 * THE CANAREELS STREAM ONE OPENER HANDS ITS VIEWER, IN THE READER'S ORDER ("Pour toi" or "Récents",
 * owner 2026-11-10, remembered on the device - `reelOrder.ts`). ONE implementation for every opener
 * of the stream (owner, 2026-11-11): the CanaReels entry (`ReelsEntryButton`) and a feed video opened
 * full screen (`PostContent`). Each opener keeps its own `startPost`; this holds the order, the
 * first page read in it and the loader built from both.
 *
 * ONE LOADER PER OPENING AND ORDER (`loader`): it keeps the ranking its pages are asked of
 * (`allReelsLoader`), and a new one IS a new list for the viewer, which starts over at the top of it
 * with the opener's `startPost` (`reels/reelList.svelte.ts`).
 */
export class ReelStream {
  order = $state<ReelOrder>(DEFAULT_REEL_ORDER);
  /** A change of order is being read: a second tap waits for it. */
  reordering = $state(false);
  /**
   * The first page of the current order, when the opener read it (the entry reads it before it
   * opens, so an empty stream opens nothing); null, the viewer reads it itself.
   */
  firstPage = $state<PostEntity[] | null>(null);
  readonly loader: ReelPageLoader = $derived(
    allReelsLoader(this.firstPage ?? undefined, this.order)
  );

  /** The switch the viewer draws at its top: this stream's order, and a change of it. */
  get choice(): ReelOrderChoice {
    return {
      value: this.order,
      busy: this.reordering,
      onChange: (next) => void this.change(next),
    };
  }

  /** The stream opens on `order` (the reader's last choice by default), with the page read in it. */
  open(firstPage: PostEntity[] | null = null, order: ReelOrder = preferredReelOrder()): void {
    console.debug(`[reels-stream] opened in the ${order} order`);
    this.order = order;
    this.firstPage = firstPage;
  }

  /** The viewer closed: nothing of this opening is kept for the next. */
  close(): void {
    this.firstPage = null;
  }

  /**
   * The reader picked another order: its first page is read, then the viewer starts over at its top
   * with the new loader. A refusal, or an empty answer, keeps the stream as it was and says so.
   */
  async change(next: ReelOrder): Promise<void> {
    if (next === this.order || this.reordering) return;
    this.reordering = true;
    console.debug(`[reels-stream] order -> ${next}`);
    try {
      const page = await listAllReels(undefined, next);
      // The same reels in another order: an empty answer means they were all withdrawn meanwhile.
      if (page.length === 0) {
        console.warn(`[reels-stream] no reel in the ${next} order - the stream stays as it was`);
        return;
      }
      rememberReelOrder(next);
      this.order = next;
      this.firstPage = page;
    } catch (err) {
      if (isTransportFailure(err)) {
        console.info('[reels-stream] no answer for the reordered reels - offline', err);
      } else {
        console.error('[reels-stream] the server refused the reordered reels', err);
      }
      showToast(m.posts_reels_open_error(), 'error');
    } finally {
      this.reordering = false;
    }
  }
}
