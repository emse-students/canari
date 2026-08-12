/**
 * codec.ts - Protobuf encode/decode helpers for the Canari wire protocol.
 *
 * Two codec layers:
 *
 * 1. Transport envelope  (WebSocket binary frames, gateway ↔ client)
 *    WsEnvelope  → binary   encodeEnvelope()
 *    binary      → InboundMsg   decodeInboundMsg()
 *
 * 2. Application payload (MLS plaintext - never seen by the server)
 *    AppMessage  → Uint8Array  encodeAppMessage()
 *    Uint8Array  → AppMessage  decodeAppMessage()
 */

import { canari } from './canari.js';

// ─── Re-export the generated types so callers don't need to import canari.js ──

export type IWsEnvelope = canari.WsEnvelope.$Properties;
export type IInboundMsg = canari.InboundMsg.$Properties;
export type IAppMessage = canari.AppMessage.$Properties;
export type IMlsFrame = canari.MlsFrame.$Properties;
export type IWelcomeFrame = canari.WelcomeFrame.$Properties;
export type IReadAck = canari.ReadAck.$Properties;
export type IRecipient = canari.Recipient.$Properties;
export type ITextMsg = canari.TextMsg.$Properties;
export type IReplyMsg = canari.ReplyMsg.$Properties;
export type IReplyRef = canari.ReplyRef.$Properties;
export type IReactionMsg = canari.ReactionMsg.$Properties;
export type IMediaMsg = canari.MediaMsg.$Properties;
export type ISystemMsg = canari.SystemMsg.$Properties;
export type ICallMsg = canari.CallMsg.$Properties;
export type IPollMsg = canari.PollMsg.$Properties;
export type IPollOption = canari.PollOption.$Properties;

export const MediaKind = canari.MediaKind;

export function mediaKindToType(kind?: number | null): 'image' | 'video' | 'audio' | 'file' {
  switch (kind) {
    case canari.MediaKind.MEDIA_KIND_IMAGE:
      return 'image';
    case canari.MediaKind.MEDIA_KIND_VIDEO:
      return 'video';
    case canari.MediaKind.MEDIA_KIND_AUDIO:
      return 'audio';
    default:
      return 'file';
  }
}

// ─── Transport layer ──────────────────────────────────────────────────────────

/**
 * Encode a WsEnvelope to binary for sending over WebSocket.
 */
export function encodeEnvelope(envelope: canari.WsEnvelope.$Properties): Uint8Array {
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
export function encodeAppMessage(msg: canari.AppMessage.$Properties): Uint8Array {
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

export function mkText(content: string): canari.AppMessage.$Properties {
  return { text: { content } };
}

export function mkReply(
  content: string,
  replyTo: { id: string; senderId: string; preview: string }
): canari.AppMessage.$Properties {
  return { reply: { content, replyTo } };
}

/**
 * Builds the frame for BOTH legs of a reaction. `removed` says which one, `at` is the sender's
 * clock for this `(user, emoji)` pair - the merge on the far side keeps the larger one, so the two
 * legs need the same shape and neither may be undated.
 */
export function mkReaction(
  messageId: string,
  emoji: string,
  at: number,
  removed = false
): canari.AppMessage.$Properties {
  return { reaction: { messageId, emoji, at, removed } };
}

export function mkMedia(media: canari.MediaMsg.$Properties): canari.AppMessage.$Properties {
  return { media };
}

export function mkSystem(event: string, data?: string): canari.AppMessage.$Properties {
  return { system: { event, data: data ?? '' } };
}

/**
 * Builds a community poll message. The question and option labels are carried
 * here (end-to-end encrypted); only the option ids are also sent in clear to the
 * server so it can tally votes without seeing the labels.
 */
export function mkPoll(poll: canari.PollMsg.$Properties): canari.AppMessage.$Properties {
  return { poll };
}

/** Builds an MLS call invitation (ring) message. */
export function mkCallInvite(
  callId: string,
  hasVideo: boolean,
  deviceId?: string
): canari.AppMessage.$Properties {
  return {
    call: {
      callId,
      hasVideo,
      deviceId: deviceId ?? '',
      offerSdp: 'START',
    },
  };
}

/** Builds an MLS call hangup message. */
export function mkCallHangup(callId: string, deviceId?: string): canari.AppMessage.$Properties {
  return {
    call: {
      callId,
      deviceId: deviceId ?? '',
      hangup: true,
    },
  };
}

/** Notifies other devices of the same user that this device picked up the call. */
export function mkCallAnswered(callId: string, deviceId: string): canari.AppMessage.$Properties {
  return {
    call: {
      callId,
      deviceId,
      answered: true,
    },
  };
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
): canari.WsEnvelope.$Properties {
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
): canari.WsEnvelope.$Properties {
  return {
    welcome: {
      ciphertext,
      groupId,
      recipients: recipients.map((r) => ({ userId: r.userId, deviceId: r.deviceId ?? '' })),
    },
  };
}

export function mkReadEnvelope(messageId: string): canari.WsEnvelope.$Properties {
  return { read: { messageId } };
}
