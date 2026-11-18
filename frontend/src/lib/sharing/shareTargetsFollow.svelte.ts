/**
 * WHEN the share sheet's suggestions are sent (sharing lot S5): at the moments a list is READ, never
 * at every change of the conversation map. See `shareTargets.ts` and `docs/wiki/frontend/sharing.md`.
 *
 * THE LIST HAS ONE KIND OF READER, AND IT IS OUTSIDE THE APP - the system share sheet and the
 * launcher. Following the map made every intermediate state of a first sync a publish: the sync
 * rebuilds the map for many seconds from inputs that are still provisional (a row a Welcome made is
 * seeded with the admission's time and falls to its real place when its history lands,
 * `conversationRecency`; a DM's name is read from a cache no effect tracks, so it enters at the next
 * unrelated re-run; a salon's community arrives with the community load), and the end of that
 * rebuild is not a fact the client holds - the history of a new device comes from peers, whenever
 * one is online. Measured: 23 publishes in one first sync (`1.7.0-alpha.12`, Mi 9T). The moment the
 * member leaves the app IS a fact, and the only one at which the list can be looked at, so it is
 * the trigger: a sync of any length costs no publish while it runs and one when the member leaves.
 * That publish runs under `holdWhileLeaving`, so iOS does not suspend the app before it lands.
 *
 * The member's switch is the other trigger - an act of theirs, answered at once: off clears, on
 * publishes. The first run of the effect at a start only clears when the switch is already off
 * (as before); with it on, the next departure publishes.
 */
import { untrack } from 'svelte';
import { onAppScreenChange } from '$lib/utils/appForeground';
import { holdWhileLeaving } from '$lib/utils/backgroundFlush';
import { syncShareTargets, type ShareTargetsInput } from './shareTargets';

/** What {@link followShareTargets} reads; every field is read at the moment of a trigger only. */
export interface ShareTargetsFollowDeps {
  /** The live input, read when a publish is due - never tracked by an effect. */
  read: () => ShareTargetsInput;
  /** The member's switch (`settings.shareSuggestionsEnabled`) - the only value tracked. */
  enabled: () => boolean;
  /** The app's screen transitions; injected for tests (`onAppScreenChange` otherwise). */
  subscribe?: (onChange: (onScreen: boolean) => void) => () => void;
  /** Keeps the process alive while the departure's publish runs; injected for tests. */
  hold?: (reason: string, work: () => Promise<unknown>) => Promise<void>;
}

/**
 * Wires the two triggers. Call during a component's initialisation (or inside `$effect.root`): the
 * subscription and the switch's effect are torn down with it.
 */
export function followShareTargets(deps: ShareTargetsFollowDeps): void {
  const subscribe = deps.subscribe ?? onAppScreenChange;
  const hold = deps.hold ?? holdWhileLeaving;
  let previous: boolean | null = null;
  $effect(() => {
    const enabled = deps.enabled();
    const was = previous;
    previous = enabled;
    // A start with the switch on publishes nothing here: the list is still being built, and the
    // next departure sends it.
    if (was === enabled || (enabled && was === null)) return;
    untrack(() =>
      syncShareTargets(deps.read(), enabled ? 'suggestions turned on' : 'suggestions turned off')
    );
  });
  $effect(() =>
    untrack(() =>
      subscribe((onScreen) => {
        if (onScreen) return;
        // HELD WHILE IT GOES: on iOS the departure arrives as the app enters the background, and
        // the native side replaces its donations one by one - a suspension mid-way would leave
        // none or a few. The hold ends when the native call has answered (`holdWhileLeaving`).
        void hold('share targets', () => syncShareTargets(deps.read(), 'left the app'));
      })
    )
  );
}
