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

/** The account ids a document names, by association id. */
export type PeopleByAssociation = Map<string, Set<string>>;

/** Adds `userId` under `assoId`, skipping anything that is not two strings (stored JSON is opaque). */
function addPerson(out: PeopleByAssociation, assoId: unknown, userId: unknown): void {
  if (typeof assoId !== 'string' || typeof userId !== 'string') return;
  const ids = out.get(assoId) ?? new Set<string>();
  ids.add(userId);
  out.set(assoId, ids);
}

/** The objects of `value` when it is an array, none otherwise. */
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    : [];
}

/** The bureau picks of a layout's bubbles (`selectedBureau`), by association id. */
export function bureauPicksByAssociation(bubbles: unknown): PeopleByAssociation {
  const out: PeopleByAssociation = new Map();
  for (const b of records(bubbles)) {
    for (const userId of Array.isArray(b.selectedBureau) ? b.selectedBureau : []) {
      addPerson(out, b.assoId, userId);
    }
  }
  return out;
}

/**
 * The people a published document names, by association id: its units' cards and its directory's
 * rosters (`members`) - the two places a publish keeps only current members.
 */
export function publishedPeopleByAssociation(publication: unknown): PeopleByAssociation {
  const out: PeopleByAssociation = new Map();
  const doc = (publication ?? {}) as { units?: unknown; directory?: { zones?: unknown } };
  for (const unit of records(doc.units)) {
    for (const card of records(unit.cards)) addPerson(out, unit.assoId, card.userId);
  }
  for (const zone of records(doc.directory?.zones)) {
    for (const asso of records(zone.assos)) {
      for (const member of records(asso.members)) addPerson(out, asso.assoId, member.userId);
    }
  }
  return out;
}

/** What the editor holds that names people: its bubbles' bureau picks and the rosters it loaded. */
export interface EditorPeople<M extends { userId: string }> {
  positioned: PositionedBubble[];
  parked: PositionedBubble[];
  members: Record<string, M[]>;
}

/**
 * The editor's state without the people the server DROPPED from what it was sent - an id named under
 * an association in `sent` and no longer under it in `stored`: someone who left that association,
 * or whose account was erased, since this editor loaded (a save and a publish keep only current
 * members). The ONE adoption, for both answers: a save's (its layout's picks) and a publish's (its
 * document's cards and rosters).
 *
 * Adopting them is what keeps the next save or publish from sending the same ids again, to be
 * dropped again with another WARN on the server. Only what the server took out is removed: a pick
 * added while the request was in flight was never sent, so it stays.
 *
 * @param local - The editor's state now (it may have moved since the request was sent).
 * @param sent - Who the request named ({@link bureauPicksByAssociation} or
 *   {@link publishedPeopleByAssociation}).
 * @param stored - Who the answer's stored row names, read the same way.
 * @returns The state to adopt and how many (association, person) pairs were dropped; `local` itself
 *   when none was.
 */
export function adoptDroppedPeople<M extends { userId: string }>(
  local: EditorPeople<M>,
  sent: PeopleByAssociation,
  stored: PeopleByAssociation
): { people: EditorPeople<M>; dropped: number } {
  const gone: PeopleByAssociation = new Map();
  let dropped = 0;
  for (const [assoId, ids] of sent) {
    const kept = stored.get(assoId);
    const cut = new Set([...ids].filter((id) => !kept?.has(id)));
    if (cut.size === 0) continue;
    gone.set(assoId, cut);
    dropped += cut.size;
  }
  if (dropped === 0) return { people: local, dropped: 0 };
  const withoutPicks = (bubbles: PositionedBubble[]) =>
    bubbles.map((bubble) => {
      const cut = gone.get(bubble.assoId);
      if (!cut || !bubble.selectedBureau?.some((id) => cut.has(id))) return bubble;
      return { ...bubble, selectedBureau: bubble.selectedBureau.filter((id) => !cut.has(id)) };
    });
  const members: Record<string, M[]> = {};
  for (const [assoId, roster] of Object.entries(local.members)) {
    const cut = gone.get(assoId);
    members[assoId] = cut ? roster.filter((m) => !cut.has(m.userId)) : roster;
  }
  return {
    people: {
      positioned: withoutPicks(local.positioned),
      parked: withoutPicks(local.parked),
      members,
    },
    dropped,
  };
}
