/**
 * WHAT A REFUSED AUTOPLAY MEANS, DECIDED FROM FACTS AT THE THROW (iPhone report, 2026-11-04: *"some
 * CanaReels do not autoplay, I have to tap play"*).
 *
 * The reel player asks `play()` itself, once per LOAD of its element (a `loadstart` opens a new one),
 * at the first load event that says the element has a resource - `loadedmetadata`, then
 * `loadeddata` / `canplay` if that one was missed. The promise's rejection is classified HERE, by its
 * `DOMException` name and two facts the player holds, and never by its message:
 *
 * - `NotAllowedError` with SOUND ON: the engine refuses an audible autoplay that it would grant
 *   muted (a browser policy; on an iPhone, an audio session it could not take). Muting is the
 *   answer the reader would get on Instagram, so the player mutes and asks AGAIN, at once. That
 *   terminates by construction: the second ask is muted, so a second refusal is the next case.
 * - `NotAllowedError` MUTED: the engine refuses any autoplay. Only then is the play button an honest
 *   answer - the reader must act.
 * - `AbortError` AFTER A NEW LOAD BEGAN (`reloaded`): the new source interrupted the ask; that load's
 *   own first event asks again. Bounded by loads, never by a count.
 * - `AbortError` WITH NO NEW LOAD: something PAUSED the element while it was being asked - the
 *   reader's tap, or the playback arbiter (the app left the screen, a call took the sound). That was
 *   somebody's decision and nothing will undo it, so the paused reel says so with its play button.
 *   Before 2026-11-04 this waited for a "next load event" that never came: a frozen reel, no button,
 *   no line above debug.
 * - Anything else (`NotSupportedError`, a decoder failure): the play button, with a warning.
 */

/** What the player does about one rejected autoplay. */
export type AutoplayVerdict =
  | { kind: 'retry-muted' }
  | { kind: 'ask-at-next-load' }
  | { kind: 'blocked'; cause: AutoplayBlockCause };

/** Why a reel will not start by itself: the play button is drawn for each. */
export type AutoplayBlockCause = 'refused' | 'interrupted' | 'errored';

/** The facts the player holds when the rejection lands. */
export interface AutoplayRejectionFacts {
  /** Whether the element was muted when it was asked. */
  muted: boolean;
  /** Whether a new load of the element began after it was asked (`loadstart`). */
  reloaded: boolean;
}

/** The `DOMException` name of a rejected `play()`, or the value's text when it is not an error. */
export function playRejectionName(err: unknown): string {
  return err instanceof Error || err instanceof DOMException ? err.name : String(err);
}

/** Classifies one rejected autoplay - see the module comment for each branch. */
export function decideAutoplayRejection(
  name: string,
  facts: AutoplayRejectionFacts
): AutoplayVerdict {
  if (name === 'NotAllowedError') {
    return facts.muted ? { kind: 'blocked', cause: 'refused' } : { kind: 'retry-muted' };
  }
  if (name === 'AbortError') {
    return facts.reloaded
      ? { kind: 'ask-at-next-load' }
      : { kind: 'blocked', cause: 'interrupted' };
  }
  return { kind: 'blocked', cause: 'errored' };
}
