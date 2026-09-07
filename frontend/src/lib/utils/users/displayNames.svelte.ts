import { SvelteMap } from 'svelte/reactivity';

import { getUserDisplayNameSync, resolveUserDisplayName } from './displayName';

/**
 * ONE user id, resolved to a display name and kept up to date - the reactive half of
 * {@link resolveUserDisplayName}.
 *
 * **Four components carried this same eight lines** (`UserName`, `MessageReactions`,
 * `MessageInfoTooltip`, `ChatMessageGroups`) and a fifth was about to be written for
 * `ChatGroupPanel`'s remove control, which is what made the duplication worth ending. The shape is
 * always the same and each half is load-bearing:
 *
 * - the SYNC read first, so a name already in the cache paints on the first frame rather than
 *   flashing the fallback;
 * - then the async resolve, whose answer may be `null` - "I could not find out" is not "there is no
 *   name", and overwriting a good label with a fallback because the network was down is the defect
 *   `displayName.ts` documents at length. So a `null` leaves what is on screen alone.
 *
 * The id is taken as a THUNK rather than a value because the caller's is reactive: a list that
 * re-keys its rows would otherwise hold the first id for ever.
 *
 * @param userId reader for the id to resolve - re-read whenever it changes
 * @param fallback what to show until the name is known; defaults to the id, as the sync reader does
 */
export function userDisplayName(userId: () => string, fallback?: () => string | undefined) {
  let name = $state('');

  $effect(() => {
    const id = userId();
    name = getUserDisplayNameSync(id, fallback?.());
    resolveUserDisplayName(id).then((resolved) => {
      // GUARDED AGAINST ITS OWN LATENCY: the id may have changed while this was in flight, and
      // writing then would label one row with another's name.
      if (resolved && userId() === id) name = resolved;
    });
  });

  return {
    get current() {
      return name;
    },
  };
}

/**
 * MANY ids at once, as a live map from id to display name.
 *
 * The single-id form above cannot serve a list: a rune reader has to be created at component init,
 * and a list's length is not known then. This resolves whatever the reader currently returns and
 * drops the entry of an id that has left the list, so a long-lived panel does not grow an unbounded
 * cache of everyone who was ever in it.
 *
 * Same two rules as {@link userDisplayName}: the sync read paints first, and a `null` resolve is
 * ignored rather than written back as a fallback.
 *
 * A `SvelteMap` rather than a `$state` holding a plain one: it is reactive per KEY, so a name
 * landing for one member repaints that member and not the whole list, and the async writes below
 * need no copy of the map to notify anybody.
 *
 * @param userIds reader for the ids to resolve - re-read whenever the list changes
 */
export function userDisplayNames(userIds: () => string[]) {
  const names = new SvelteMap<string, string>();
  // THE KEYS ARE TRACKED HERE, OUTSIDE THE MAP, AND THAT IS THE WHOLE OF THE RULE. Pruning has to
  // know which ids to drop, and the only other way to know is to ask the map - which would make the
  // effect below read what it writes. An effect that depends on its own output re-runs for ever and
  // the page dies with `effect_update_depth_exceeded`; a `svelte:boundary` catches it, so the app
  // does not crash, it renders "Impossible d'afficher cette discussion" over every conversation
  // instead. Measured on the local estate 2026-09-07, and it cost GRP two rows before a screenshot
  // said what no verdict had. A plain array is not reactive, so reading it costs no dependency.
  let held: string[] = [];

  $effect(() => {
    const ids = userIds();
    for (const id of held) if (!ids.includes(id)) names.delete(id);
    held = ids;
    // Nothing is lost by not carrying names across a change of list: `getUserDisplayNameSync` reads
    // the module-level cache `resolveUserDisplayName` fills, so a name already known is already
    // there, and a local copy of it was only ever a second copy.
    for (const id of ids) names.set(id, getUserDisplayNameSync(id));

    for (const id of ids) {
      resolveUserDisplayName(id).then((resolved) => {
        // The list may have changed while this was in flight; writing an id it no longer holds
        // would resurrect a row that is gone.
        if (!resolved || !userIds().includes(id)) return;
        names.set(id, resolved);
      });
    }
  });

  return names;
}
