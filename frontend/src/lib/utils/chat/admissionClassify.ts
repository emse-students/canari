import type { IMlsService } from '$lib/mls-client/IMlsService';

/**
 * Closing a CONVERSATION for the admission rule (`mls-core` `admission.rs`).
 *
 * A conversation refuses an external commit that brings a user in on their own; a community or salon
 * key group, whose members enter by external commit by design, must stay open. `mls-core` cannot tell
 * the two apart, the app can: a conversation has a row, and a key group never does. So the app closes
 * what it positively knows to be a conversation, and nothing else - a group it cannot name stays
 * unclassified and keeps merging its external commits, exactly as before the rule.
 *
 * The decision is made where a conversation row is saved, which is every way a conversation comes to
 * exist (created here, joined by a Welcome, restored at start-up).
 */
type Classifier = Pick<
  IMlsService,
  'setAdmissionPolicy' | 'getAdmissionPolicy' | 'isDistributionGroup'
>;

/** Groups already closed through each service, so a save that happens per message asks once. */
const closed = new WeakMap<object, Set<string>>();

/**
 * Closes `groupId` for the admission rule unless it is a key group or already closed. Idempotent and
 * never throws: a failure leaves the group unclassified - the behaviour it always had - and is said
 * at WARN, because the rule then does not apply to it.
 *
 * @returns whether the group is closed after the call.
 */
export async function closeConversationAdmission(
  mls: Classifier,
  groupId: string,
  log: (msg: string) => void = (msg) => console.warn(msg)
): Promise<boolean> {
  try {
    let done = closed.get(mls);
    if (!done) {
      done = new Set();
      closed.set(mls, done);
    }
    if (done.has(groupId)) return true;
    // NEVER A KEY GROUP: closing one would refuse every newcomer of a community.
    if (mls.isDistributionGroup(groupId)) return false;
    if ((await mls.getAdmissionPolicy(groupId)) !== 'closed') {
      await mls.setAdmissionPolicy(groupId, 'closed');
    }
    done.add(groupId);
    return true;
  } catch (e) {
    log(
      `[ADMISSION] conversation ${groupId.slice(0, 8)}... could not be closed (it stays unclassified): ${String(e)}`
    );
    return false;
  }
}
