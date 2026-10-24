import type { DistributionFrame } from '$lib/mls-client/IMlsService';
import type { canari } from '$lib/proto/canari';
import {
  isGraineReady,
  requireGraineRuntime,
  whenHistoryRuleKnown,
  type GraineRuntime,
} from './runtime';
import { communityKeyGroupOf } from './admissionGate';

/**
 * SEED ASKS THIS DEVICE CANNOT DECIDE YET, waiting for the one event that lets it.
 *
 * Two waits, one queue (channel-encryption sections 25 and "the floor is the member's"):
 *
 * - **the community's key group to DRAIN** ({@link parkAsk}). The admission gate observes a voucher
 *   only on a drained key group, and an ask that arrives ON the key group is that group's current
 *   work - so the gate run inside it can never see the group drained, and a newcomer who asks the
 *   moment they join would meet `unobserved` every time;
 * - **the community's history RULE to be known** ({@link parkAskUntilRuleKnown}). This session has
 *   not learned whether the community shares its past, and a floor drawn under a guessed `joined`
 *   would lose a `shared` past for good. The answer waits for the listing that states the rule
 *   (`whenHistoryRuleKnown`), instead of a silence re-asked only at the requester's next start.
 *
 * Neither is a refusal. The ask is parked here, in memory, and decided again by the event:
 *
 * - ONE PER ASKING DEVICE, COMMUNITY AND KIND: a device that asks again replaces its earlier ask.
 * - BOUNDED ({@link MAX_PARKED_ASKS}, both waits together): past the bound the oldest ask is
 *   dropped, at warn.
 * - IN MEMORY: an ask lost with the app is asked again by its device at its next start. Forgotten at
 *   sign-out ({@link clearParkedAsks}).
 * - RE-DECIDED, NEVER ASSUMED: the event re-runs the whole answer, gate included. A decision that
 *   has become a refusal (a signer removed before the observation, a link expired) is answered as
 *   that refusal, which the answer path logs; one that meets the other wait is parked again.
 */

/** The most asks parked at once on this device, across communities and waits. */
export const MAX_PARKED_ASKS = 64;

/** What answers a parked ask again - the frame handler's own answer path. */
export type AskAnswerer = (
  frame: DistributionFrame,
  request: canari.GraineRequestMsg.$Properties
) => Promise<void>;

/** The event a parked ask waits for. */
type AskWait = { kind: 'drain'; keyGroupId: string } | { kind: 'rule'; workspaceId: string };

interface ParkedAsk {
  frame: DistributionFrame;
  request: canari.GraineRequestMsg.$Properties;
  wait: AskWait;
  answer: AskAnswerer;
  /** The session it was parked in: answered only in that one, never in the next account's. */
  session: GraineRuntime;
}

/** By `workspaceId|user:device|kind`, in parking order - the first entry is the oldest. */
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
  if (!enqueue(frame, request, answer, session, { kind: 'drain', keyGroupId })) return;
  console.info(
    `[GRAINE] parked ${frame.sender}:${frame.senderDeviceId}'s ask in community ${frame.workspaceId.slice(0, 8)} ` +
      `until key group ${keyGroupId.slice(0, 8)} drains (${parked.size} parked)`
  );
  if (armed.get(keyGroupId) === session) return;
  armed.set(keyGroupId, session);
  void mlsService.whenGroupDrained(keyGroupId).then(
    () => releaseParked((wait) => wait.kind === 'drain' && wait.keyGroupId === keyGroupId, session),
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
 * Parks `frame`'s ask until this session learns the community's history rule, then answers it
 * again with `answer`. The wake is `whenHistoryRuleKnown`, which runs once the listing states the
 * rule and is dropped, said, with the session or the community.
 */
export function parkAskUntilRuleKnown(
  frame: DistributionFrame,
  request: canari.GraineRequestMsg.$Properties,
  answer: AskAnswerer
): void {
  const session = requireGraineRuntime('cannot park a seed ask');
  const { workspaceId } = frame;
  // One wake per community is enough: it releases every ask of the community waiting for the rule.
  const woken = [...parked.values()].some(
    (ask) =>
      ask.session === session && ask.wait.kind === 'rule' && ask.wait.workspaceId === workspaceId
  );
  if (!enqueue(frame, request, answer, session, { kind: 'rule', workspaceId })) return;
  if (
    !woken &&
    !whenHistoryRuleKnown(workspaceId, () =>
      releaseParked((wait) => wait.kind === 'rule' && wait.workspaceId === workspaceId, session)
    )
  ) {
    // Nothing would ever wake it: dropped now rather than held until the bound evicts it.
    parked.delete(keyOf(frame, request));
    console.warn(
      `[GRAINE] DROPPED ${frame.sender}:${frame.senderDeviceId}'s ask in community ${workspaceId.slice(0, 8)}: ` +
        `too many steps already wait for a history rule - it is asked again at that device's next start`
    );
    return;
  }
  console.info(
    `[GRAINE] parked ${frame.sender}:${frame.senderDeviceId}'s ask in community ${workspaceId.slice(0, 8)} ` +
      `until this session learns its history rule (${parked.size} parked)`
  );
}

function keyOf(frame: DistributionFrame, request: canari.GraineRequestMsg.$Properties): string {
  // BY KIND TOO: a HISTORY ask and a SESSIONS repair from one device are two questions, and the
  // later one must not erase the earlier.
  return `${frame.workspaceId}|${frame.sender}:${frame.senderDeviceId ?? ''}|${request.kind ?? ''}`;
}

/**
 * Adds one ask to the queue: drops the asks of an earlier session, replaces this device's earlier
 * ask of the same kind, and evicts the oldest past the bound.
 *
 * @returns false when the ask itself was evicted at once (never, with a bound above zero).
 */
function enqueue(
  frame: DistributionFrame,
  request: canari.GraineRequestMsg.$Properties,
  answer: AskAnswerer,
  session: GraineRuntime,
  wait: AskWait
): boolean {
  // Asks of an earlier session are that account's, and its wait died with its service.
  const stale = [...parked].filter(([, ask]) => ask.session !== session);
  if (stale.length > 0) {
    for (const [key] of stale) parked.delete(key);
    console.info(`[GRAINE] dropped ${stale.length} parked ask(s) of an earlier session`);
  }
  const key = keyOf(frame, request);
  if (parked.delete(key)) {
    console.info(
      `[GRAINE] ${frame.sender}:${frame.senderDeviceId} asked again (kind ${request.kind}) in community ${frame.workspaceId.slice(0, 8)} - its parked ask is replaced`
    );
  }
  parked.set(key, { frame, request, wait, answer, session });
  while (parked.size > MAX_PARKED_ASKS) {
    const [oldest, ask] = parked.entries().next().value as [string, ParkedAsk];
    parked.delete(oldest);
    console.warn(
      `[GRAINE] DROPPED the parked ask of ${ask.frame.sender}:${ask.frame.senderDeviceId} in community ` +
        `${ask.frame.workspaceId.slice(0, 8)}: more than ${MAX_PARKED_ASKS} asks wait to be decided - it is asked again at that device's next start`
    );
  }
  return parked.has(key);
}

/**
 * Answers again every ask of `session` whose wait `due` names, one at a time and each in its own
 * `try`: one that throws does not keep the others from their answer. An ask that meets a wait again
 * is parked again by its own answer path.
 */
async function releaseParked(
  due: (wait: AskWait) => boolean,
  session: GraineRuntime
): Promise<void> {
  const ready = [...parked].filter(([, ask]) => due(ask.wait) && ask.session === session);
  for (const [, ask] of ready) {
    if (ask.wait.kind === 'drain' && armed.get(ask.wait.keyGroupId) === session) {
      armed.delete(ask.wait.keyGroupId);
    }
  }
  for (const [key] of ready) parked.delete(key);
  const what = ready[0] ? describeWait(ready[0][1].wait) : 'a wait';
  if (!isGraineReady() || requireGraineRuntime('cannot answer a parked ask') !== session) {
    console.info(
      `[GRAINE] ${what} ended after its session ended - ${ready.length} parked ask(s) dropped`
    );
    return;
  }
  console.info(`[GRAINE] ${what} ended - deciding ${ready.length} parked ask(s) again`);
  for (const [, ask] of ready) {
    try {
      await ask.answer(ask.frame, ask.request);
    } catch (e) {
      console.warn(
        `[GRAINE] the parked ask of ${ask.frame.sender}:${ask.frame.senderDeviceId} in community ` +
          `${ask.frame.workspaceId.slice(0, 8)} could not be answered after ${what} ended: ${String(e)}`
      );
    }
  }
}

function describeWait(wait: AskWait): string {
  return wait.kind === 'drain'
    ? `the wait for key group ${wait.keyGroupId.slice(0, 8)} to drain`
    : `the wait for community ${wait.workspaceId.slice(0, 8)}'s history rule`;
}

/** How many asks are parked now. */
export function parkedAskCount(): number {
  return parked.size;
}

/**
 * Forgets every parked ask and every armed wait: called at sign-out, next to `setGraineRuntime(null)`,
 * so no sender id or request of the account that left stays in memory until a reload. The MLS
 * service's own drain waiters are settled by its `destroy`, and the rule waiters by
 * `setGraineRuntime(null)`.
 */
export function clearParkedAsks(): void {
  if (parked.size > 0) {
    console.info(`[GRAINE] forgetting ${parked.size} parked ask(s): the session ended`);
  }
  parked.clear();
  armed.clear();
}
