/**
 * HOW MANY GIF THUMBNAILS DOWNLOAD AT ONCE.
 *
 * A page of the picker mounts a screenful of tiles plus an overscan, and every `<img>` asked for its
 * GIF in the same instant - a dozen animated thumbnails of up to 2.9 MB each, sharing one phone's
 * link. They all arrived late and together, and past the GIF relay's own ceiling (16 distinct
 * downloads at once) it ANSWERED 503 `busy`: the tiles that lost that race stayed blank for good.
 *
 * The gate lets a few downloads run, in the order the tiles asked (top of the screen first), and
 * hands a slot to the next tile when one finishes. A tile that scrolls away before its turn leaves
 * the queue without ever having asked the network for anything.
 */

/** A place in the queue: resolves when the holder may start its download. */
export interface GateTicket {
  /** Resolves once a slot is granted; never resolves if the ticket was cancelled first. */
  granted: Promise<void>;
  /** Gives the slot back (the download ended, however it ended). A no-op the second time. */
  release: () => void;
}

export interface ImageGate {
  acquire: () => GateTicket;
  /** How many downloads hold a slot now. */
  readonly active: number;
}

/** Creates a gate letting at most `limit` downloads run together. */
export function createImageGate(limit: number): ImageGate {
  let active = 0;
  const waiting: { grant: () => void; cancelled: boolean }[] = [];

  function next() {
    while (active < limit && waiting.length > 0) {
      const waiter = waiting.shift()!;
      if (waiter.cancelled) continue;
      active++;
      waiter.grant();
    }
  }

  return {
    get active() {
      return active;
    },
    acquire(): GateTicket {
      let grantedHere = false;
      let done = false;
      const entry = { grant: () => {}, cancelled: false };
      const granted = new Promise<void>((resolve) => {
        entry.grant = () => {
          grantedHere = true;
          resolve();
        };
      });
      waiting.push(entry);
      next();
      return {
        granted,
        release() {
          if (done) return;
          done = true;
          if (grantedHere) {
            active--;
          } else {
            // Left the queue before its turn: it never held a slot.
            entry.cancelled = true;
          }
          next();
        },
      };
    },
  };
}

/** Thumbnails that may download together. Six keeps a phone's link busy without starving the top rows. */
export const GIF_THUMBNAIL_CONCURRENCY = 6;

/** The one gate every picker thumbnail goes through. */
export const gifImageGate = createImageGate(GIF_THUMBNAIL_CONCURRENCY);
