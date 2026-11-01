import type { IStorage } from '$lib/db';
import type { AddMessageToChatOptions, Conversation } from '$lib/types';
import {
  buildCallEndedText,
  buildCallOutcomeText,
  mkCallStartedEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from '$lib/envelope';
import { callEndReasonFromWire, type CallEndReason, type ICallMsg } from '$lib/proto/codec';
import { appendLog } from '$lib/utils/sessionLog';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import type { SvelteMap } from 'svelte/reactivity';
import { notificationPreferences } from '$lib/stores/notificationPreferences.svelte';
import { callsAvailableAnswered } from '$lib/utils/callsAvailability';
import type { EventTime } from '$lib/utils/chat/visibleNotices';

/** Dependencies required to insert or update call system messages in a conversation. */
export interface CallSystemMessageContext {
  userId: string;
  /** The session's CURRENT device key, read at the write - this context outlives a PIN change. */
  deviceKey: () => string;
  storage: IStorage | null;
  conversations: SvelteMap<string, Conversation>;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    options?: AddMessageToChatOptions
  ) => Promise<void>;
}

let activeContext: CallSystemMessageContext | null = null;
const endedCallIds = new Set<string>();

/** Registers the chat context used by call lifecycle notifications. Cleared on logout. */
export function setCallSystemMessageContext(ctx: CallSystemMessageContext | null): void {
  activeContext = ctx;
  if (!ctx) endedCallIds.clear();
}

/** Returns the currently registered call system-message context, if any. */
export function getCallSystemMessageContext(): CallSystemMessageContext | null {
  return activeContext;
}

function callMessageId(callId: string): string {
  return `call-${callId}`;
}

function isCallInvite(callMsg: ICallMsg): boolean {
  return callMsg.offerSdp === 'START';
}

/** `at` as Unix ms - the instant a call record is stamped with. */
function eventMs(at: EventTime): number {
  return at.timestamp.getTime();
}

/**
 * Inserts a system message when a call starts.
 * Idempotent per callId (dedupes local start + MLS invite echo).
 *
 * `at` is WHEN THE CALL STARTED, never when this device learnt of it: the invite frame's `sentAt` and
 * the server's acceptance of it (`receivedNoticeTime`), or, on the caller's own device, the invite it
 * just sent - the same frame, so the same instant every member's copy carries.
 */
export async function recordCallStarted(
  ctx: CallSystemMessageContext | null,
  groupId: string,
  callId: string,
  starterId: string,
  at: EventTime
): Promise<void> {
  if (!ctx || !callId || endedCallIds.has(callId)) return;

  const convo = ctx.conversations.get(groupId);
  if (!convo) return;

  const messageId = callMessageId(callId);
  if (convo.messages.some((m) => m.id === messageId)) return;

  const getName = await resolveDisplayNames([starterId]);
  // The call may have ENDED during that await (a busy answer arrives in milliseconds): its final
  // record is written, and a "started" row now would sit beside it with the same id.
  if (endedCallIds.has(callId)) return;
  const starterName = getName(starterId.toLowerCase());
  const envelope = mkCallStartedEnvelope(starterName, callId, starterId.toLowerCase(), eventMs(at));
  await ctx.addMessageToChat('system', serializeEnvelope(envelope), groupId, {
    isSystem: true,
    messageId,
    ...at,
    // Nothing echoes a call row (it is written locally from signals), so it must never wait in the
    // bulk-ingest buffer, where a later finalization could not find it and would write a second row.
    soleWriter: true,
  });
}

/**
 * THE ONE WRITER OF A CALL'S FINAL RECORD. Every end of a call - an answered one, a cancelled, declined,
 * unanswered or busy one, and an invite that never rang - is written here, and nowhere else. Two writers
 * (a "missed" one and a "duration" one) used to disagree about the same call: an unanswered call read
 * "started a call that lasted less than a minute".
 *
 * `outcome` is the TYPED reason the call ended unanswered ({@link CallEndReason}); absent means it
 * was answered and the record gets its duration. Idempotent per callId, and final: the structured
 * `endedAt` flag (never the text) guards a duplicate signal, so the first end wins.
 *
 * When this device holds no row for the call, one is CREATED only if the caller says who started it
 * (`starterId`) and there is an outcome: a busy or unrung device has no "started" row to finalize.
 */
export async function recordCallEnded(
  ctx: CallSystemMessageContext | null,
  groupId: string,
  callId: string,
  at: EventTime,
  outcome?: CallEndReason,
  starterId?: string
): Promise<void> {
  if (!ctx || !callId || endedCallIds.has(callId)) return;
  endedCallIds.add(callId);

  const convo = ctx.conversations.get(groupId);
  if (!convo) {
    appendLog(`[CallRecord] end of ${callId} dropped: no conversation ${groupId.slice(0, 8)}`);
    return;
  }

  const messageId = callMessageId(callId);
  const idx = convo.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) {
    if (!outcome || !starterId) return;
    const starter = starterId.toLowerCase();
    const getName = await resolveDisplayNames([starter]);
    const endedAt = eventMs(at);
    // The timeline may have gained this very row during the await: never write a second one -
    // finalize the one that arrived.
    if (ctx.conversations.get(groupId)?.messages.some((x) => x.id === messageId)) {
      await finalizeCallRow(ctx, groupId, callId, endedAt, outcome);
      return;
    }
    appendLog(`[CallRecord] ${callId} written as ${outcome} (no started row on this device)`);
    await ctx.addMessageToChat(
      'system',
      serializeEnvelope({
        kind: 'system',
        text: buildCallOutcomeText(outcome, starter === ctx.userId.toLowerCase(), getName(starter)),
        callEvent: { callId, starterId: starter, startedAt: endedAt, endedAt, outcome },
      }),
      groupId,
      { isSystem: true, messageId, soleWriter: true, ...at }
    );
    return;
  }

  await finalizeCallRow(ctx, groupId, callId, eventMs(at), outcome);
}

/**
 * Finalizes the EXISTING row of a call, read from the timeline as it is NOW (never a snapshot taken
 * before an await: writing back an old list would erase what arrived meanwhile).
 */
async function finalizeCallRow(
  ctx: CallSystemMessageContext,
  groupId: string,
  callId: string,
  endedAt: number,
  outcome: CallEndReason | undefined
): Promise<void> {
  const messageId = callMessageId(callId);
  const convo = ctx.conversations.get(groupId);
  const idx = convo ? convo.messages.findIndex((m) => m.id === messageId) : -1;
  if (!convo || idx === -1) return;
  const msg = convo.messages[idx];
  const env = parseEnvelope(msg.content);
  if (env.kind !== 'system' || !env.callEvent) return;
  // Already finalized (a missed invite is written final): a duplicate end leaves it as it is.
  if (env.callEvent.endedAt) return;

  const starter = env.callEvent.starterId;
  const getName = await resolveDisplayNames([starter]);
  const starterName = getName(starter);
  // The conversation may have moved during that await: take the row from the CURRENT timeline,
  // never from the snapshot read before it (a write of the old list would erase what arrived).
  const current = ctx.conversations.get(groupId);
  const curIdx = current ? current.messages.findIndex((x) => x.id === messageId) : -1;
  if (!current || curIdx === -1) {
    appendLog(`[CallRecord] ${callId} row gone before its end was written`);
    return;
  }
  const curMsg = current.messages[curIdx];
  const nextText = outcome
    ? buildCallOutcomeText(outcome, starter === ctx.userId.toLowerCase(), starterName)
    : buildCallEndedText(starterName, endedAt - env.callEvent.startedAt);
  appendLog(`[CallRecord] ${callId} finalized as ${outcome ?? 'answered'}`);
  const nextContent = serializeEnvelope({
    ...env,
    text: nextText,
    callEvent: { ...env.callEvent, endedAt, ...(outcome ? { outcome } : {}) },
  });

  const msgs = [...current.messages];
  msgs[curIdx] = { ...curMsg, content: nextContent };
  ctx.conversations.set(groupId, { ...current, messages: msgs });

  if (ctx.storage) {
    // Rewriting the call-ended text is a mutation of an existing row: only the body changes, and
    // a full-row write here erased every other field the row carried.
    await ctx.storage
      .updateMessage(messageId, { content: nextContent }, ctx.deviceKey())
      .catch((e: unknown) =>
        appendLog(`[CallRecord] ${callId} not persisted: ${String(e).slice(0, 120)}`)
      );
  }
}

/**
 * Handles an incoming MLS call signal: inserts a start message or updates duration on hangup.
 */
export async function handleCallSignalForChat(
  ctx: CallSystemMessageContext | null,
  senderId: string,
  groupId: string,
  callMsg: ICallMsg,
  currentUserId: string,
  at: EventTime | null
): Promise<void> {
  if (!ctx || !callMsg?.callId) return;
  // A RECORD IS DATED BY ITS FRAME, never by when this device processed it: a phone draining an
  // invite and its hangup hours late wrote "missed call" below everything said since. With neither
  // the frame's `sentAt` nor the server's acceptance there is no instant to give it, and none is
  // invented.
  if (!at) {
    console.error(
      `[CallRecord] ${String(callMsg.callId).slice(0, 8)} signal in ${groupId.slice(0, 8)}… REFUSED: the frame carries no sentAt and its delivery no server time - no durable instant dates the record, and this device's clock is not one`
    );
    return;
  }

  const senderNorm = senderId.toLowerCase();
  const userNorm = currentUserId.toLowerCase();

  if (callMsg.hangup) {
    const outcome = callEndReasonFromWire(callMsg.endReason);
    // A device with no "started" row for this call (it was busy, or never saw the invite) still
    // owes its owner a MISSED call when ANOTHER account gave up on it: the caller's own other
    // devices and a ring this account refused elsewhere are not missed calls.
    const missedHere = outcome && outcome !== 'declined' && senderNorm !== userNorm;
    await recordCallEnded(
      ctx,
      groupId,
      callMsg.callId,
      at,
      outcome,
      missedHere ? senderNorm : undefined
    );
    return;
  }

  // BUSY is answered to the caller's DEVICE, which ends its own call and writes its own record
  // (`CallService`); no other device writes anything for it.
  if (callMsg.busy) return;

  if (callMsg.answered) {
    return;
  }

  if (isCallInvite(callMsg)) {
    if (senderNorm === userNorm) return;
    // A conversation that may not ring this account (its call permission, read by `CallService`
    // too, which therefore does not ring): the call is written as MISSED at once, so it is visible
    // in the timeline instead of the ring. Missed is final (`endedAt` set), so the caller's later
    // hangup leaves it as it is.
    // The same predicate as `CallService` (the server's kill switch, awaited until answered): an
    // invite that will not ring is a MISSED call, never a "call started" line with no ring.
    if (!notificationPreferences.callsAllowed(groupId) || !(await callsAvailableAnswered())) {
      await recordCallEnded(ctx, groupId, callMsg.callId, at, 'not-answered', senderNorm);
      return;
    }
    await recordCallStarted(ctx, groupId, callMsg.callId, senderId, at);
  }
}
