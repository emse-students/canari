/**
 * The two rules the carte editor's saving obeys, kept out of the page so they can be tested.
 *
 * Both exist because of a defect the editor shipped with: opening a project wrote it back, and a
 * publish could send a state the server had never been given.
 */
import type { PositionedBubble, Decoration } from './layout';

/** Everything the editor persists, except the background image itself - see {@link bgVersion}. */
export interface LayoutFingerprintParts {
  titleColor: string;
  scrimOpacity: number;
  directoryVisible: boolean;
  bubbles: PositionedBubble[];
  decorations: Decoration[];
  /**
   * A counter bumped wherever the background image is replaced or cleared.
   *
   * The image is a data URL of up to several MB and this fingerprint is recomputed on every pointer
   * frame of a drag, so the bytes themselves must never enter it. A counter is exact rather than
   * approximate - unlike a length or a hash of the tail - because the image only changes where the
   * editor bumps it.
   */
  bgVersion: number;
}

/**
 * One comparable string for the persisted state.
 *
 * The field order is fixed HERE rather than at the call site, because two spellings of the same
 * state that stringify differently would read as an edit and save on their own.
 */
export function layoutFingerprint(parts: LayoutFingerprintParts): string {
  return JSON.stringify([
    parts.titleColor,
    parts.scrimOpacity,
    parts.directoryVisible,
    parts.bgVersion,
    parts.bubbles,
    parts.decorations,
  ]);
}

/** A saver that runs one write at a time. */
export interface SerialSaver {
  /**
   * Saves, BEHIND whatever save is already in flight.
   *
   * @returns Whether the state is now on the server. It never rejects: a caller that wants to know
   *   reads the boolean, and a background autosave can ignore it without leaving an unhandled
   *   rejection behind.
   */
  save(): Promise<boolean>;
}

/**
 * Serialises writes so a second one never overtakes the first, and so a caller that must know the
 * state reached the server can WAIT for the one already running.
 *
 * Returning early while a save was in flight is what let a publish send a state the server had
 * never been given: the editor saves before publishing precisely so the live map can be reproduced
 * by reopening the project, and that guarantee died on the early return.
 *
 * A failed write never strands the queue - the next one runs regardless of how the last ended.
 *
 * @param persist - Performs one write; rejecting means it did not reach the server.
 */
export function createSerialSaver(persist: () => Promise<void>): SerialSaver {
  let queue: Promise<void> = Promise.resolve();
  return {
    save(): Promise<boolean> {
      const run = queue.then(() =>
        persist().then(
          () => true,
          () => false
        )
      );
      queue = run.then(() => undefined);
      return run;
    },
  };
}
