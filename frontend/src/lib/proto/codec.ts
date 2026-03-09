/**
 * codec.ts – Protobuf encode/decode helpers for the Canari wire protocol.
 *
 * Two codec layers:
 *
 * 1. Transport envelope  (WebSocket binary frames, gateway ↔ client)
 *    WsEnvelope  → binary   encodeEnvelope()
 *    binary      → InboundMsg   decodeInboundMsg()
 *
 * 2. Application payload (MLS plaintext – never seen by the server)
 *    AppMessage  → Uint8Array  encodeAppMessage()
 *    Uint8Array  → AppMessage  decodeAppMessage()
 */

import { canari } from './canari.js';

// ─── Re-export the generated types so callers don't need to import canari.js ──

export type IWsEnvelope = canari.IWsEnvelope;
export type IInboundMsg = canari.IInboundMsg;
export type IAppMessage = canari.IAppMessage;
export type IMlsFrame = canari.IMlsFrame;
export type IWelcomeFrame = canari.IWelcomeFrame;
export type IReadAck = canari.IReadAck;
export type IRecipient = canari.IRecipient;
export type ITextMsg = canari.ITextMsg;
export type IReplyMsg = canari.IReplyMsg;
export type IReplyRef = canari.IReplyRef;
export type IReactionMsg = canari.IReactionMsg;
export type IMediaMsg = canari.IMediaMsg;
export type ISystemMsg = canari.ISystemMsg;

export const MediaKind = canari.MediaKind;

// ─── Transport layer ──────────────────────────────────────────────────────────

/**
 * Encode a WsEnvelope to binary for sending over WebSocket.
 */
export function encodeEnvelope(envelope: canari.IWsEnvelope): Uint8Array {
  return canari.WsEnvelope.encode(canari.WsEnvelope.create(envelope)).finish();
}

/**
 * Decode a binary WebSocket frame received from the server into an InboundMsg.
 */
export function decodeInboundMsg(bytes: Uint8Array): canari.InboundMsg {
  return canari.InboundMsg.decode(bytes);
}

// ─── Application payload layer ────────────────────────────────────────────────

/**
 * Encode an AppMessage to raw bytes to be passed to MLS encryption.
 */
export function encodeAppMessage(msg: canari.IAppMessage): Uint8Array {
  return canari.AppMessage.encode(canari.AppMessage.create(msg)).finish();
}

/**
 * Decode raw bytes (MLS plaintext) back into an AppMessage.
 * Returns null if decoding fails (e.g. legacy plain-text message).
 */
export function decodeAppMessage(bytes: Uint8Array): canari.AppMessage | null {
  try {
    return canari.AppMessage.decode(bytes);
  } catch {
    return null;
  }
}

// ─── Convenience builders (avoid spreading canari.IXxx everywhere) ────────────

export function mkText(content: string): canari.IAppMessage {
  return { text: { content } };
}

export function mkReply(
  content: string,
  replyTo: { id: string; senderId: string; preview: string }
): canari.IAppMessage {
  return { reply: { content, replyTo } };
}

export function mkReaction(messageId: string, emoji: string): canari.IAppMessage {
  return { reaction: { messageId, emoji } };
}

export function mkMedia(media: canari.IMediaMsg): canari.IAppMessage {
  return { media };
}

export function mkSystem(event: string, data?: string): canari.IAppMessage {
  return { system: { event, data: data ?? '' } };
}

// ─── Envelope builders ────────────────────────────────────────────────────────

export interface RecipientSpec {
  userId: string;
  /** Empty string = fan-out to all devices. */
  deviceId?: string;
}

export function mkMlsEnvelope(
  ciphertext: Uint8Array,
  groupId: string,
  recipients: RecipientSpec[] = []
): canari.IWsEnvelope {
  return {
    mls: {
      ciphertext,
      groupId,
      recipients: recipients.map((r) => ({ userId: r.userId, deviceId: r.deviceId ?? '' })),
    },
  };
}

export function mkWelcomeEnvelope(
  ciphertext: Uint8Array,
  groupId: string,
  recipients: RecipientSpec[]
): canari.IWsEnvelope {
  return {
    welcome: {
      ciphertext,
      groupId,
      recipients: recipients.map((r) => ({ userId: r.userId, deviceId: r.deviceId ?? '' })),
    },
  };
}

export function mkReadEnvelope(messageId: string): canari.IWsEnvelope {
  return { read: { messageId } };
}
