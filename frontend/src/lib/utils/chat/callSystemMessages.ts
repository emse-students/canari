import type { IStorage } from '$lib/db';
import type { AddMessageToChatOptions, Conversation } from '$lib/types';
import {
  buildCallEndedText,
  mkCallStartedEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from '$lib/envelope';
import type { ICallMsg } from '$lib/proto/codec';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import type { SvelteMap } from 'svelte/reactivity';
import { m } from '$lib/paraglide/messages';

/** Dependencies required to insert or update call system messages in a conversation. */
export interface CallSystemMessageContext {
  userId: string;
  pin: string;
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

/**
 * Inserts a system message when a call starts.
 * Idempotent per callId (dedupes local start + MLS invite echo).
 */
export async function recordCallStarted(
  ctx: CallSystemMessageContext | null,
  groupId: string,
  callId: string,
  starterId: string
): Promise<void> {
  if (!ctx || !callId) return;

  const convo = ctx.conversations.get(groupId);
  if (!convo) return;

  const messageId = callMessageId(callId);
  if (convo.messages.some((m) => m.id === messageId)) return;

  const getName = await resolveDisplayNames([starterId]);
  const starterName = getName(starterId.toLowerCase());
  const envelope = mkCallStartedEnvelope(starterName, callId, starterId.toLowerCase());
  await ctx.addMessageToChat('system', serializeEnvelope(envelope), groupId, {
    isSystem: true,
    messageId,
  });
}

/**
 * Updates the call system message with the final duration.
 * Idempotent per callId.
 */
export async function recordCallEnded(
  ctx: CallSystemMessageContext | null,
  groupId: string,
  callId: string
): Promise<void> {
  if (!ctx || !callId || endedCallIds.has(callId)) return;
  endedCallIds.add(callId);

  const convo = ctx.conversations.get(groupId);
  if (!convo) return;

  const messageId = callMessageId(callId);
  const idx = convo.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return;

  const msg = convo.messages[idx];
  const env = parseEnvelope(msg.content);
  if (env.kind !== 'system' || !env.callEvent) return;
  // Already finalized: the structured `endedAt` flag (not the display text) guards
  // against re-processing a duplicate hangup, so it survives text translation.
  if (env.callEvent.endedAt) return;

  const endedAt = Date.now();
  const durationMs = endedAt - env.callEvent.startedAt;
  const getName = await resolveDisplayNames([env.callEvent.starterId]);
  const starterName = getName(env.callEvent.starterId);
  const nextText = buildCallEndedText(starterName, durationMs);
  const nextContent = serializeEnvelope({
    ...env,
    text: nextText,
    callEvent: { ...env.callEvent, endedAt },
  });

  const msgs = [...convo.messages];
  msgs[idx] = { ...msg, content: nextContent };
  ctx.conversations.set(groupId, { ...convo, messages: msgs });

  if (ctx.storage) {
    await ctx.storage
      .saveMessage(
        {
          id: messageId,
          conversationId: groupId,
          senderId: 'system',
          content: nextContent,
          timestamp: msg.timestamp.getTime(),
        },
        ctx.pin
      )
      .catch(() => {});
  }
}

/**
 * Inserts a "Missed call" system message when the caller hangs up before anyone answers.
 * Idempotent per callId.
 */
export async function recordCallMissed(
  ctx: CallSystemMessageContext | null,
  groupId: string,
  callId: string,
  callerId: string
): Promise<void> {
  if (!ctx || !callId) return;

  const convo = ctx.conversations.get(groupId);
  if (!convo) return;

  const messageId = callMessageId(callId);
  // If a call-started message already exists (someone picked up remotely), skip.
  if (convo.messages.some((m) => m.id === messageId)) return;

  const getName = await resolveDisplayNames([callerId]);
  const callerName = getName(callerId.toLowerCase());
  const text = m.chat_system_call_missed({ caller: callerName });
  const envelope = serializeEnvelope({
    kind: 'system',
    text,
    callEvent: {
      callId,
      starterId: callerId.toLowerCase(),
      startedAt: Date.now(),
      endedAt: Date.now(),
    },
  });

  await ctx.addMessageToChat('system', envelope, groupId, {
    isSystem: true,
    messageId,
  });
}

/**
 * Handles an incoming MLS call signal: inserts a start message or updates duration on hangup.
 */
export async function handleCallSignalForChat(
  ctx: CallSystemMessageContext | null,
  senderId: string,
  groupId: string,
  callMsg: ICallMsg,
  currentUserId: string
): Promise<void> {
  if (!ctx || !callMsg?.callId) return;

  const senderNorm = senderId.toLowerCase();
  const userNorm = currentUserId.toLowerCase();

  if (callMsg.hangup) {
    await recordCallEnded(ctx, groupId, callMsg.callId);
    return;
  }

  if (callMsg.answered) {
    return;
  }

  if (isCallInvite(callMsg)) {
    if (senderNorm === userNorm) return;
    await recordCallStarted(ctx, groupId, callMsg.callId, senderId);
  }
}
