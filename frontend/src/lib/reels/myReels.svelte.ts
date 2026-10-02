/**
 * THE MEMBER'S OWN LIVE REELS (`GET /api/posts/my-reels`) - what says a reel is theirs, how long it
 * has left, and the key that saving it before its deletion needs (C6).
 *
 * WHY NOT `authorId`: a reel published as an association or anonymously carries no `authorId` for
 * anybody, its author included, yet it is theirs to save. The server's list is the one answer.
 *
 * THE DAYS ARE COUNTED ON THE SERVER'S CLOCK (`serverNow`), never the phone's: a phone set a day
 * wrong would otherwise announce the wrong deletion date.
 *
 * ONE REQUEST, KEPT UNTIL A FACT SAYS IT IS STALE. The answer is reused for every card and every
 * viewer slide; it is asked again only when a reel being drawn was created AFTER the answer's
 * `serverNow` and is not in it - a reel published since cannot be in an older list. Never a timer.
 */
import { getMyReels, type MyReel, type MyReelsAnswer, type PostEntity } from '$lib/posts/api';
import { currentUserId } from '$lib/stores/userState.svelte';

/** One `my-reels` answer and the account it was asked for. */
interface HeldAnswer {
  userId: string | null;
  answer: MyReelsAnswer;
}

/**
 * The author's reels, loaded once and refreshed by facts.
 *
 * THE LIST BELONGS TO THE ACCOUNT THAT ASKED FOR IT. The app's one copy outlives a sign-out, so an
 * answer held for another account than the signed-in one speaks for nobody: `find` answers nothing
 * and `ensure` asks again.
 */
export class MyReelsState {
  #held = $state.raw<HeldAnswer | null>(null);
  #inFlight: Promise<void> | null = null;
  readonly #fetch: () => Promise<MyReelsAnswer>;
  readonly #whoAmI: () => string | null;

  constructor(
    fetch: () => Promise<MyReelsAnswer> = getMyReels,
    whoAmI: () => string | null = currentUserId
  ) {
    this.#fetch = fetch;
    this.#whoAmI = whoAmI;
  }

  /** The answer held for the signed-in account, or `null`. */
  get answer(): MyReelsAnswer | null {
    const held = this.#held;
    return held && held.userId === this.#whoAmI() ? held.answer : null;
  }

  /** The member's own reel with this id, or `undefined` when it is not theirs (or not loaded). */
  find(id: string): MyReel | undefined {
    return this.answer?.reels.find((r) => r.id === id);
  }

  /**
   * Makes sure the answer can speak for this reel: loads it when there is none for this account,
   * and again when the reel is newer than the answer and absent from it.
   */
  ensure(post: Pick<PostEntity, 'id' | 'createdAt'>): void {
    const answer = this.answer;
    if (answer) {
      if (this.find(post.id)) return;
      if (Date.parse(post.createdAt) <= Date.parse(answer.serverNow)) return;
      console.debug(`[my-reels] ${post.id} is newer than the list: asking again`);
    }
    void this.#load();
  }

  #load(): Promise<void> {
    if (this.#inFlight) return this.#inFlight;
    const userId = this.#whoAmI();
    this.#inFlight = this.#fetch()
      .then((answer) => {
        this.#held = { userId, answer };
        console.debug(`[my-reels] ${answer.reels.length} live reels`);
      })
      .catch((err: unknown) => {
        // Nothing is drawn as the member's own until the list answers; the next card asks again.
        console.error('[my-reels] the list could not be read', err);
      })
      .finally(() => {
        this.#inFlight = null;
      });
    return this.#inFlight;
  }
}

/** The app's one copy. */
export const myReels = new MyReelsState();
