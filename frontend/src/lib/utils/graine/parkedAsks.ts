import type { DistributionFrame } from '$lib/mls-client/IMlsService';
import type { canari } from '$lib/proto/canari';
import { isGraineReady, requireGraineRuntime, type GraineRuntime } from './runtime';
import { communityKeyGroupOf } from './admissionGate';

/**
 * SEED ASKS WAITING FOR THE COMMUNITY'S KEY GROUP TO DRAIN (channel-encryption section 25).
 *
 * The admission gate observes a voucher only on a drained key group, and an ask that arrives ON the
 * key group is that group's current work - so the gate run inside it can never see the group drained,
 * and a newcomer who asks the moment they join would meet `unobserved` every time. Such an ask is not
 * a refusal: it is parked here, in memory, and decided again by the drain that follows it.
 *
 * - ONE PER ASKING DEVICE, COMMUNITY AND KIND: a device that asks again replaces its earlier ask.
 * - BOUNDED ({@link MAX_PARKED_ASKS}): past the bound the oldest ask is dropped, at warn.
 * - IN MEMORY: an ask lost with the app is asked again by its device at its next start. Forgotten at
 *   sign-out ({@link clearParkedAsks}).
 * - RE-DECIDED, NEVER ASSUMED: the drain re-runs the whole answer, gate included. A decision that has
 *   become a refusal (a signer removed before the observation, a link expired) is answered as that
 *   refusal, which the answer path logs.
 */

/** The most asks parked at once on this device, across communities. */
export const MAX_PARKED_ASKS = 64;

/** What answers a parked ask again - the frame handler's own answer path. */
export type AskAnswerer = (
  frame: DistributionFrame,
  request: canari.GraineRequestMsg.$Properties
) => Promise<void>;

interface ParkedAsk {
  frame: DistributionFrame;
  request: canari.GraineRequestMsg.$Properties;
  keyGroupId: string;
  answer: AskAnswerer;
  /** The session it was parked in: answered only in that one, never in the next account's. */
  session: GraineRuntime;
}

/** By `workspaceId|user:device`, in parking order - the first entry is the oldest. */
const parked = new Map<string, ParkedAsk>();

/**
 * Key groups whose drain is already waited for, with the session that waits: armed once per group
 * and session. A session that ended leaves its wait pending with its service, and the next one arms
 * its own.
 */
const armed = new Map<string, GraineRuntime>();

/**
 * Parks `frame`'s ask until the community's key group drains on this device, then answers it again
 * with `answer`. Never awaits the drain: the caller is inside a frame of that very group.
 *
 * @throws When this device holds no key group for the community - the caller's gate already failed
 *   closed on that, so it is not reached in practice.
 */
export function parkAsk(
  frame: DistributionFrame,
  request: canari.GraineRequestMsg.$Properties,
  answer: AskAnswerer
): void {
  const session = requireGraineRuntime('cannot park a seed ask');
  const { mlsService } = session;
  const keyGroupId = communityKeyGroupOf(mlsService, frame.workspaceId);
  // Asks of an earlier session are that account's, and its wait died with its service.
  const stale = [...parked].filter(([, ask]) => ask.session !== session);
  if (stale.length > 0) {
    for (const [key] of stale) parked.delete(key);
    console.info(`[GRAINE] dropped ${stale.length} parked ask(s) of an earlier session`);
  }
  // BY KIND TOO: a HISTORY ask and a SESSIONS repair from one device are two questions, and the
  // later one must not erase the earlier.
  const key = `${frame.workspaceId}|${frame.sender}:${frame.senderDeviceId ?? ''}|${request.kind ?? ''}`;
  if (parked.delete(key)) {
    console.info(
      `[GRAINE] ${frame.sender}:${frame.senderDeviceId} asked again (kind ${request.kind}) in community ${frame.workspaceId.slice(0, 8)} - its parked ask is replaced`
    );
  }
  parked.set(key, { frame, request, keyGroupId, answer, session });
  while (parked.size > MAX_PARKED_ASKS) {
    const [oldest, ask] = parked.entries().next().value as [string, ParkedAsk];
    parked.delete(oldest);
    console.warn(
      `[GRAINE] DROPPED the parked ask of ${ask.frame.sender}:${ask.frame.senderDeviceId} in community ` +
        `${ask.frame.workspaceId.slice(0, 8)}: more than ${MAX_PARKED_ASKS} asks wait for a key group to drain - it is asked again at that device's next start`
    );
  }
  console.info(
    `[GRAINE] parked ${frame.sender}:${frame.senderDeviceId}'s ask in community ${frame.workspaceId.slice(0, 8)} ` +
      `until key group ${keyGroupId.slice(0, 8)} drains (${parked.size} parked)`
  );
  if (armed.get(keyGroupId) === session) return;
  armed.set(keyGroupId, session);
  void mlsService.whenGroupDrained(keyGroupId).then(
    () => releaseParked(keyGroupId, session),
    (e: unknown) => {
      // The service ended (`GroupDrainAbandonedError`): sign-out already forgot these asks.
      if (armed.get(keyGroupId) === session) armed.delete(keyGroupId);
      console.info(
        `[GRAINE] stopped waiting for key group ${keyGroupId.slice(0, 8)} to drain: ${String(e)}`
      );
    }
  );
}

/**
 * Answers again every ask parked on `keyGroupId` in `session`, one at a time and each in its own
 * `try`: one that throws does not keep the others from their answer. An ask that meets an undrained
 * group again is parked again by its own answer path.
 */
async function releaseParked(keyGroupId: string, session: GraineRuntime): Promise<void> {
  if (armed.get(keyGroupId) === session) armed.delete(keyGroupId);
  const due = [...parked].filter(
    ([, ask]) => ask.keyGroupId === keyGroupId && ask.session === session
  );
  for (const [key] of due) parked.delete(key);
  if (!isGraineReady() || requireGraineRuntime('cannot answer a parked ask') !== session) {
    console.info(
      `[GRAINE] key group ${keyGroupId.slice(0, 8)} drained after its session ended - ${due.length} parked ask(s) dropped`
    );
    return;
  }
  console.info(
    `[GRAINE] key group ${keyGroupId.slice(0, 8)} drained - deciding ${due.length} parked ask(s) again`
  );
  for (const [, ask] of due) {
    try {
      await ask.answer(ask.frame, ask.request);
    } catch (e) {
      console.warn(
        `[GRAINE] the parked ask of ${ask.frame.sender}:${ask.frame.senderDeviceId} in community ` +
          `${ask.frame.workspaceId.slice(0, 8)} could not be answered after the drain: ${String(e)}`
      );
    }
  }
}

/** How many asks are parked now. */
export function parkedAskCount(): number {
  return parked.size;
}

/**
 * Forgets every parked ask and every armed wait: called at sign-out, next to `setGraineRuntime(null)`,
 * so no sender id or request of the account that left stays in memory until a reload. The MLS
 * service's own drain waiters are settled by its `destroy`.
 */
export function clearParkedAsks(): void {
  if (parked.size > 0) {
    console.info(`[GRAINE] forgetting ${parked.size} parked ask(s): the session ended`);
  }
  parked.clear();
  armed.clear();
}
