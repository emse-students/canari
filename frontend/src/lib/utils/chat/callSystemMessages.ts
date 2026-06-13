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
  if (env.text.includes('qui a duré')) return;

  const durationMs = Date.now() - env.callEvent.startedAt;
  const getName = await resolveDisplayNames([env.callEvent.starterId]);
  const starterName = getName(env.callEvent.starterId);
  const nextText = buildCallEndedText(starterName, durationMs);
  const nextContent = serializeEnvelope({ ...env, text: nextText });

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
