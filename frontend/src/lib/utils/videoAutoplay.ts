/**
 * WHAT A REFUSED AUTOPLAY MEANS, DECIDED FROM FACTS AT THE THROW (iPhone report, 2026-11-04: *"some
 * CanaReels do not autoplay, I have to tap play"*).
 *
 * The reel player asks `play()` itself, once per LOAD of its element (a `loadstart` opens a new one),
 * at the first load event that says the element has a resource - `loadedmetadata`, then
 * `loadeddata` / `canplay` if that one was missed. The promise's rejection is classified HERE, by its
 * `DOMException` name and one fact the player reads when the rejection lands, never by its message:
 *
 * - `NotAllowedError`: the engine refuses this autoplay - muted (a browser policy, a power saving
 *   mode) or with the sound the reader turned on. The play button is the answer, and the reader's tap
 *   plays it as it is. A refusal NEVER mutes: the sound is the reader's explicit choice, and an engine
 *   refusal does not override it (lead decision, 2026-11-04, under the owner's rule "a reel starts
 *   muted, sound only if the user turns it on").
 * - `AbortError` with a NEW SOURCE (`sourceChanged`): the element's `src` differs from the one the
 *   ask was made on, so the load that replaced it interrupted the ask. That load's own first event
 *   asks again. This is read from `src` and not from the next `loadstart`, because the load algorithm
 *   rejects the pending `play()` synchronously and only QUEUES `loadstart`: when the rejection lands,
 *   `loadstart` has not fired yet, but `src` already names the new resource.
 * - `AbortError`, same source: something PAUSED the element while it was being asked - the reader's
 *   tap, or the playback arbiter (the app left the screen, a call took the sound). That was somebody's
 *   decision and nothing will undo it, so the paused reel says so with its play button.
 * - Anything else (`NotSupportedError`, a decoder failure): the play button, with a warning.
 */

/** What the player does about one rejected autoplay. */
export type AutoplayVerdict =
  | { kind: 'ask-at-next-load' }
  | { kind: 'blocked'; cause: AutoplayBlockCause };

/** Why a reel will not start by itself: the play button is drawn for each. */
export type AutoplayBlockCause = 'refused' | 'interrupted' | 'errored';

/** The fact the player reads when the rejection lands. */
export interface AutoplayRejectionFacts {
  /** Whether the element's `src` is no longer the one the autoplay was asked on. */
  sourceChanged: boolean;
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
  if (name === 'NotAllowedError') return { kind: 'blocked', cause: 'refused' };
  if (name === 'AbortError') {
    return facts.sourceChanged
      ? { kind: 'ask-at-next-load' }
      : { kind: 'blocked', cause: 'interrupted' };
  }
  return { kind: 'blocked', cause: 'errored' };
}
