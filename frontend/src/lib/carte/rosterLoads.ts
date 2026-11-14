/**
 * The rosters the carte editor depends on, each with its LOAD STATE.
 *
 * A roster that failed to load is NOT an empty roster: the editor used to catch the failure and
 * draw the association with nobody, and a publish then wrote that empty list onto the live carte
 * (a transport failure presented as an empty state). The state is typed here, at the catch, so no
 * caller has to infer it from an empty array or from an error message.
 */
import type { AssociationMember } from '$lib/associations/api';
import { Log } from '$lib/utils/Log';

/**
 * One association's roster, as far as this editor knows it. `stale`: the server refused a publish
 * because this roster, as loaded, no longer matches who the members are (`CARTE_ROSTER_MISSING`) -
 * usually a member who joined after the editor opened.
 */
export type RosterLoad =
  | { state: 'loading' }
  | { state: 'loaded'; members: AssociationMember[] }
  | { state: 'failed' }
  | { state: 'stale' };

/** Every roster the editor asked for, by association id. */
export type RosterLoads = Record<string, RosterLoad>;

/** Reads one association's roster. */
export type RosterFetch = (associationId: string) => Promise<AssociationMember[]>;

/**
 * Loads one roster. ANY failure - a transport failure, a refusal, or an answer that is not a list -
 * leaves it `failed`: in every case the editor does not know who the members are, which is all that
 * matters to what it may publish.
 *
 * A review account (`reviewAccount`, shown only to the platform admin) is left out: no public roster
 * carries one, and the carte is public. The server drops it at publish too; leaving it out here is
 * what keeps the editor from sending it, and the publish from reading as changed.
 */
export async function loadRoster(associationId: string, fetch: RosterFetch): Promise<RosterLoad> {
  Log.d('carte.rosterLoads.loadRoster', { associationId });
  try {
    const answer: unknown = await fetch(associationId);
    if (!Array.isArray(answer)) {
      Log.w('carte.rosterLoads.loadRoster answered no list: the roster is NOT drawn empty', {
        associationId,
        kind: typeof answer,
      });
      return { state: 'failed' };
    }
    const members = (answer as AssociationMember[]).filter((mem) => mem.reviewAccount !== true);
    if (members.length !== answer.length) {
      Log.d('carte.rosterLoads.loadRoster left review accounts out', {
        associationId,
        left: answer.length - members.length,
      });
    }
    return { state: 'loaded', members };
  } catch (e) {
    Log.w('carte.rosterLoads.loadRoster failed: the roster is NOT drawn empty', {
      associationId,
      e,
    });
    return { state: 'failed' };
  }
}

/** Loads every roster of `associationIds` in parallel; a failure leaves only its own `failed`. */
export async function loadRosters(
  associationIds: readonly string[],
  fetch: RosterFetch
): Promise<RosterLoads> {
  const loads = await Promise.all(associationIds.map((id) => loadRoster(id, fetch)));
  const out: RosterLoads = {};
  associationIds.forEach((id, i) => (out[id] = loads[i]));
  return out;
}

/** The members of every LOADED roster - what the model is drawn from. A roster not loaded is absent. */
export function loadedMembers(loads: RosterLoads): Record<string, AssociationMember[]> {
  const out: Record<string, AssociationMember[]> = {};
  for (const [id, load] of Object.entries(loads)) {
    if (load.state === 'loaded') out[id] = load.members;
  }
  return out;
}

/** The ids of `drawn` whose roster is not loaded (failed, stale, still loading, or never asked). */
export function rostersNotLoaded(drawn: readonly string[], loads: RosterLoads): string[] {
  return drawn.filter((id) => loads[id]?.state !== 'loaded');
}

/**
 * The associations a map SHOWS that its editor could not read at all: switched on and offered by
 * the space, yet absent from the catalogue it loaded. Drawing without them would publish a map
 * missing a unit with nothing on screen to say so.
 */
export function shownButUnlisted(
  shown: ReadonlySet<string>,
  offered: readonly string[],
  listed: ReadonlySet<string>
): string[] {
  return offered.filter((id) => shown.has(id) && !listed.has(id));
}

/** What stands between the map and a publish or an export: nothing (null), or what is missing. */
export interface PublishBlock {
  /** Drawn associations whose roster is not loaded. */
  rosters: string[];
  /** Shown associations the catalogue did not list. */
  unlisted: string[];
}

/**
 * Whether the map may be published (or exported) as drawn: every drawn association's roster loaded,
 * and every shown association listed. A failed roster would otherwise be published EMPTY.
 *
 * @returns null when nothing blocks; the missing rosters and associations otherwise.
 */
export function publishBlock(
  drawn: readonly string[],
  loads: RosterLoads,
  unlisted: readonly string[]
): PublishBlock | null {
  const rosters = rostersNotLoaded(drawn, loads);
  if (rosters.length === 0 && unlisted.length === 0) return null;
  return { rosters, unlisted: [...unlisted] };
}

/** Marks `associationIds` as `stale` (the server said their roster no longer matches). */
export function markStale(loads: RosterLoads, associationIds: readonly string[]): RosterLoads {
  const out: RosterLoads = { ...loads };
  for (const id of associationIds) out[id] = { state: 'stale' };
  return out;
}

/**
 * THE ONE GATE IN FRONT OF A PUBLISH OR AN EXPORT: runs `act` only when nothing blocks, and reports
 * the block otherwise. Both editor actions go through it, so the refusal is decided - and tested -
 * in one place rather than repeated in each handler.
 *
 * @param block - What blocks now ({@link publishBlock}), or null.
 * @param onRefused - Told what blocks, when `act` is not run.
 * @param act - The publish or the export.
 * @returns Whether `act` ran.
 */
export async function runUnlessBlocked(
  block: PublishBlock | null,
  onRefused: (block: PublishBlock) => void,
  act: () => Promise<void>
): Promise<boolean> {
  if (block) {
    Log.w('carte.rosterLoads.runUnlessBlocked refused: a roster or an association is not loaded', {
      rosters: block.rosters,
      unlisted: block.unlisted,
    });
    onRefused(block);
    return false;
  }
  await act();
  return true;
}
