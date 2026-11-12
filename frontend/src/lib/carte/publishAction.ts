/**
 * What the editor offers about the publication, decided in one place so the top bar and its "..."
 * menu cannot disagree (owner, 2026-11-11: one bar, "Mettre a jour la publication" one click away).
 *
 * Publishing is already a REPLACEMENT on the server (one transaction clears the space's live map
 * and sets this one), so updating the publication is the same call as publishing: no unpublish
 * first, and no server change.
 */

/** An action of the "..." menu. */
export type OverflowAction = 'update' | 'unpublish' | 'export';

/** The facts the decision reads. */
export interface PublicationFacts {
  /** This map is the one live on the portail. */
  isPublished: boolean;
  /** The fingerprint the server recorded for the live document; null when unknown. */
  liveFingerprint: string | null;
  /** The fingerprint of the document the SAVED state would publish; null while unknown. */
  savedFingerprint: string | null;
}

/**
 * How the live map relates to the saved one.
 *
 * `unknown` is its own answer: a map published before the fingerprint existed has none, and
 * claiming it is current would hide exactly the staleness this exists to show.
 */
export function publicationState(f: PublicationFacts): 'offline' | 'current' | 'stale' | 'unknown' {
  if (!f.isPublished) return 'offline';
  if (f.liveFingerprint === null || f.savedFingerprint === null) return 'unknown';
  return f.liveFingerprint === f.savedFingerprint ? 'current' : 'stale';
}

/**
 * The publication button the bar shows: "publish" while offline, "update" when the live map is
 * older than the saved one or cannot be compared, nothing when it is current.
 */
export function barPublishAction(f: PublicationFacts): 'publish' | 'update' | null {
  const state = publicationState(f);
  if (state === 'offline') return 'publish';
  return state === 'current' ? null : 'update';
}

/**
 * The entries of the "..." menu, in order. A live map can always be republished from here (the
 * bar button is only shown when it is older), and taken off; the export is always there.
 */
export function overflowActions(f: PublicationFacts): OverflowAction[] {
  const actions: OverflowAction[] = [];
  if (f.isPublished) {
    if (barPublishAction(f) === null) actions.push('update');
    actions.push('unpublish');
  }
  actions.push('export');
  return actions;
}
