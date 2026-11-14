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

/** Each placed bubble's bureau picks in a stored layout, by association id. */
function bureauByAssociation(bubbles: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!Array.isArray(bubbles)) return out;
  for (const b of bubbles) {
    const { assoId, selectedBureau } = (b ?? {}) as { assoId?: unknown; selectedBureau?: unknown };
    if (typeof assoId !== 'string' || !Array.isArray(selectedBureau)) continue;
    out.set(assoId, new Set(selectedBureau.filter((u): u is string => typeof u === 'string')));
  }
  return out;
}

/**
 * The editor's bubbles without the bureau picks the server DROPPED on a save: an id the editor sent
 * for an association and the stored layout no longer has - someone who left that association, or
 * whose account was erased, since this editor loaded (the server keeps only current members).
 *
 * Adopting them is what keeps the next save from sending the same ids again, to be dropped again
 * with another WARN on the server. Only what the server took out is removed: a pick the author
 * added while the save was in flight was never sent, so it stays.
 *
 * @param local - The editor's bubbles now (they may have moved since the save was sent).
 * @param sent - The `bubbles` of the layout the save sent.
 * @param stored - The `bubbles` of the layout the server answered with.
 * @returns The bubbles to adopt and how many picks were removed; `local` itself when none was.
 */
export function adoptDroppedBureauPicks(
  local: PositionedBubble[],
  sent: unknown,
  stored: unknown
): { bubbles: PositionedBubble[]; dropped: number } {
  const before = bureauByAssociation(sent);
  const after = bureauByAssociation(stored);
  let dropped = 0;
  const bubbles = local.map((bubble) => {
    const was = before.get(bubble.assoId);
    const kept = after.get(bubble.assoId);
    if (!was || !bubble.selectedBureau) return bubble;
    const gone = (id: string) => was.has(id) && !kept?.has(id);
    const next = bubble.selectedBureau.filter((id) => !gone(id));
    if (next.length === bubble.selectedBureau.length) return bubble;
    dropped += bubble.selectedBureau.length - next.length;
    return { ...bubble, selectedBureau: next };
  });
  return dropped > 0 ? { bubbles, dropped } : { bubbles: local, dropped: 0 };
}
