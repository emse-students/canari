import type { DelegationReadiness } from '$lib/utils/chat/tabCommitDelegation';

/** What {@link createLeadPublisher} drives: the election, the delegation readiness, the lead holds. */
export interface LeadPublisherDeps {
  setTabLeadEligibility(eligible: boolean, why: string): void;
  setDelegationReadiness(readiness: DelegationReadiness): void;
  noteTabSessionLive(): void;
  leadHoldsInFlight(): number;
  /** The holds in flight, named. */
  describeLeadHolds(): string;
  onLeadHoldsReleased(listener: () => void): () => void;
  /** Where the accusation of a session ended with holds in flight goes. */
  warn(message: string): void;
}

/**
 * THE ONE PLACE A SESSION'S STATE BECOMES THE TAB'S LEAD AND ITS ANSWER TO FOLLOWERS, in that order.
 *
 * `publish(readiness)` is called by the one writer of the session's flags (`useChatSession`) on
 * every change, and again by itself when the last MLS operation holding the lead settles:
 * 1. **eligibility first**: a session that cannot serve gives the lead up - but only once no MLS
 *    operation that needs the lead is in flight (`leadHolds.ts`): a commit posted and not yet
 *    checkpointed, a delegated executor, a key-package mint, a final checkpoint. Given up earlier,
 *    the write latch would refuse their writes as a follower's;
 * 2. **then the delegation readiness**, so the drain that change starts runs in a document that no
 *    longer leads when it gave the lead up, and leaves the requests to the next leader;
 * 3. **a live session ends a deferred rejoin** (`noteTabSessionLive`), so a session is never left
 *    outside the election by a promotion reload that never concluded.
 */
export function createLeadPublisher(deps: LeadPublisherDeps): {
  publish(readiness: DelegationReadiness): void;
} {
  let last: DelegationReadiness | null = null;
  /** Said once per session end: a hold still in flight then is what keeps the lead here. */
  let heldPastEndSaid = false;
  function publish(readiness: DelegationReadiness): void {
    last = readiness;
    const holding = deps.leadHoldsInFlight();
    if (readiness !== 'unavailable') heldPastEndSaid = false;
    else if (holding > 0 && !heldPastEndSaid) {
      // SAID AT WARN, NAMING THEM (second review of #4053): every hold ends on its own, so this is
      // normally a moment; a hold that never ends keeps the lead - and every follower's request -
      // here for good, and this line is what names it.
      heldPastEndSaid = true;
      deps.warn(
        `[TAB] the session cannot serve, but ${holding} MLS operation(s) still need the lead - it is kept until they settle: ${deps.describeLeadHolds()}`
      );
    }
    deps.setTabLeadEligibility(
      readiness !== 'unavailable' || holding > 0,
      holding > 0
        ? `session ${readiness}, ${holding} MLS operation(s) still in flight`
        : `session ${readiness}`
    );
    deps.setDelegationReadiness(readiness);
    if (readiness === 'ready') deps.noteTabSessionLive();
  }
  // The last operation that held the lead settled: a session that cannot serve gives it up now.
  deps.onLeadHoldsReleased(() => {
    if (last !== null) publish(last);
  });
  return { publish };
}
