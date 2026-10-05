import { SvelteMap } from 'svelte/reactivity';

import { fetchUserProfile } from '$lib/stores/user';
import { Log } from '$lib/utils/Log';
import { sortByFamilyName, type PersonNameParts } from './familyNameOrder';

/**
 * A list of user ids, kept in family-name order (see {@link sortByFamilyName}) - the reactive half
 * that a member panel renders from.
 *
 * A member row carries only an id; the name columns come from the profile (`firstName`,
 * `lastName`), fetched through {@link fetchUserProfile}, which batches every id of one tick into a
 * single request and shares its 30-second cache with the `UserName` cells of the same rows.
 *
 * A ROW NEVER MOVES BECAUSE ITS NAME ARRIVED. Sorting as names land would reshuffle the list under
 * the reader's finger, once per batch. So:
 *
 * - an id is listed in `current` only once its profile lookup has SETTLED (answered or failed);
 *   until then it is counted in `pending`, and a panel whose every id is pending shows its loading
 *   line instead of a list in an order about to change;
 * - an id's sort key is FROZEN the moment it settles. A lookup that failed (a 404, a dead network)
 *   freezes as "unnamed", which sorts last in id order, and a name that resolves later - after a
 *   reconnect, say - repaints the row's `UserName` in place without moving it. A key is read
 *   again only once its id has left the list and come back - a mount, or a panel that empties its
 *   list on close.
 *
 * A member who joins while the panel is open appears directly at their place once their own lookup
 * settles; the rows already there only make room for them.
 *
 * @param userIds reader for the ids to order - re-read whenever the list changes
 */
export function membersByFamilyName(userIds: () => string[]) {
  /** The frozen sort key of every settled id; `null` = settled with no name. */
  const keys = new SvelteMap<string, PersonNameParts | null>();
  // Plain, untracked bookkeeping: the effect below must not read what its own callbacks write, or
  // it re-runs on every answer (`displayNames.svelte.ts` documents the loop that shape produced).
  // A `SvelteSet` here is exactly that loop, which is why the lint rule is overruled on this line.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- must stay untracked, see above
  const requested = new Set<string>();

  $effect(() => {
    const ids = userIds();
    // Deleting the entry being visited is safe in a `Set` iteration.
    for (const id of requested) {
      if (!ids.includes(id)) {
        requested.delete(id);
        keys.delete(id);
      }
    }
    for (const id of ids) {
      if (requested.has(id)) continue;
      requested.add(id);
      fetchUserProfile(id.trim().toLowerCase())
        .then((profile): PersonNameParts => profile)
        .catch((e): null => {
          // Not a path, a degraded order: this member sorts last for the life of the panel.
          Log.d('memberOrder.membersByFamilyName profile lookup failed - sorted last', {
            userId: id,
            error: e,
          });
          return null;
        })
        .then((parts) => {
          // The id may have left the list while this was in flight; writing it would resurrect it.
          if (!requested.has(id) || keys.has(id)) return;
          keys.set(id, parts);
        });
    }
  });

  const ordered = $derived.by(() => {
    const ids = userIds();
    const settled = ids.filter((id) => keys.has(id));
    return {
      current: sortByFamilyName(
        settled,
        (id) => keys.get(id),
        (id) => id
      ),
      pending: ids.length - settled.length,
    };
  });

  return {
    /** The settled ids, in family-name order, unnamed last. */
    get current() {
      return ordered.current;
    },
    /** How many ids are still waiting for their lookup to settle. */
    get pending() {
      return ordered.pending;
    },
  };
}

/**
 * The ids a member panel must still show as a "joining" row: nobody may be absent between being
 * invited and being listed.
 *
 * A member is on screen in exactly ONE of two places - the ordered list, or a joining row - and
 * the hand-over is decided by what the list RENDERS ({@link membersByFamilyName}'s `current`), not
 * by what the roster HOLDS. The two differ for as long as the newcomer's profile lookup is in
 * flight: the roster already carries the id, the list does not list it yet. Hiding the joining row
 * on roster membership therefore made the newcomer appear (invited), disappear (in the roster,
 * not yet listed) and appear again (listed) - 2026-10-05, the day the ordering shipped.
 *
 * - every invited id not yet listed is a joining row;
 * - once the list has rows at all, so is every roster id not yet listed (a member who joined
 *   through another device, or whose invitation ended before the lookup did). With NO row listed
 *   the panel shows its loading line instead, and a joining row per id would duplicate it.
 *
 * @param invited ids with an invitation in flight, lower-cased
 * @param roster the ids the roster holds
 * @param listed the ids the ordered list renders
 */
export function joiningRows(invited: string[], roster: string[], listed: string[]): string[] {
  const shown = listed.map((id) => id.toLowerCase());
  const out: string[] = [];
  const add = (id: string) => {
    const key = id.toLowerCase();
    if (shown.includes(key) || out.includes(key)) return;
    out.push(key);
  };
  invited.forEach(add);
  if (listed.length > 0) roster.forEach(add);
  return out;
}
