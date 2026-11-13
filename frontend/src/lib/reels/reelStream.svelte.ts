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
  /** The viewer is open on this stream (`open` to `close`). */
  opened = $state(false);
  /**
   * The first page of the current order, when the opener read it (the entry reads it before it
   * opens, so an empty stream opens nothing); null, the viewer reads it itself. Replaced by `open`
   * and by a change, NEVER cleared by `close`: clearing it would hand a closing viewer a new loader,
   * a new list built only to be torn down.
   */
  firstPage = $state<PostEntity[] | null>(null);
  readonly loader: ReelPageLoader = $derived(
    allReelsLoader(this.firstPage ?? undefined, this.order)
  );
  /**
   * WHICH OPENING IS CURRENT: bumped by `open` and by `close`. A change's read carries the opening it
   * was asked in, and an answer that lands after that opening ended is dropped - it would otherwise
   * reopen a closed entry's viewer, or reorder a later opening, and remember an order nobody saw.
   */
  #opening = 0;

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
    this.#opening += 1;
    console.debug(`[reels-stream] opening ${this.#opening} in the ${order} order`);
    this.order = order;
    this.firstPage = firstPage;
    this.reordering = false;
    this.opened = true;
  }

  /** The viewer closed: this opening is over, and a change still in flight for it is dropped. */
  close(): void {
    console.debug(`[reels-stream] opening ${this.#opening} closed`);
    this.#opening += 1;
    this.opened = false;
  }

  /**
   * The reader picked another order: its first page is read, then the viewer starts over at its top
   * with the new loader. A refusal, or an empty answer, keeps the stream as it was and says so; an
   * answer for an opening that has ended is dropped and said, and nothing is remembered.
   */
  async change(next: ReelOrder): Promise<void> {
    if (!this.opened || next === this.order || this.reordering) return;
    const opening = this.#opening;
    this.reordering = true;
    console.debug(`[reels-stream] order -> ${next} (opening ${opening})`);
    try {
      const page = await listAllReels(undefined, next);
      if (opening !== this.#opening) {
        console.debug(
          `[reels-stream] the ${next} reels landed after opening ${opening} ended - dropped`
        );
        return;
      }
      // The same reels in another order: an empty answer means they were all withdrawn meanwhile.
      if (page.length === 0) {
        console.warn(`[reels-stream] no reel in the ${next} order - the stream stays as it was`);
        return;
      }
      rememberReelOrder(next);
      this.order = next;
      this.firstPage = page;
    } catch (err) {
      if (opening !== this.#opening) {
        console.debug(`[reels-stream] the ${next} read failed after opening ${opening} ended`, err);
        return;
      }
      if (isTransportFailure(err)) {
        console.info('[reels-stream] no answer for the reordered reels - offline', err);
      } else {
        console.error('[reels-stream] the server refused the reordered reels', err);
      }
      showToast(m.posts_reels_open_error(), 'error');
    } finally {
      // A later opening owns the flag from its `open`.
      if (opening === this.#opening) this.reordering = false;
    }
  }
}
