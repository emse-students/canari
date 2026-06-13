/**
 * envelope.ts - Unified message envelope for all chat message types.
 *
 * Every message stored in ChatMessage.content is a serialized MessageEnvelope.
 * The `kind` discriminant lets renderers decide how to display a message without
 * relying on heuristics over the raw string.
 *
 * Future combinations (e.g. text caption + media attachment) can be added as new
 * fields on existing variants without breaking old serialized messages.
 */

import type { MediaRef } from '$lib/media';
import type { MessageReference } from '$lib/types';
import { formatMentionsForPreview } from '$lib/utils/mentions.parse';

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export interface TextEnvelope {
  kind: 'text';
  text: string;
  replyTo?: MessageReference;
}

export interface MediaEnvelope {
  kind: 'media';
  media: MediaRef;
  /** Optional text caption alongside the attachment. */
  caption?: string;
  replyTo?: MessageReference;
}

/** System / group-event notification (never user-authored). */
export interface SystemEnvelope {
  kind: 'system';
  text: string;
  /** Present when the system event is a channel invitation; enables the Join button in the UI. */
  channelInvite?: {
    channelId: string;
    channelName: string;
    workspaceName?: string;
  };
  /** Metadata for call lifecycle messages (start → duration update on hangup). */
  callEvent?: {
    callId: string;
    starterId: string;
    startedAt: number;
  };
}

export type MessageEnvelope = TextEnvelope | MediaEnvelope | SystemEnvelope;

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/** Serialize a MessageEnvelope to a JSON string suitable for storage in StoredMessage.content. */
export function serializeEnvelope(env: MessageEnvelope): string {
  return JSON.stringify(env);
}

/**
 * Returns a short preview string suitable for lists or reply contexts.
 */
export function getPreviewText(env: MessageEnvelope): string {
  switch (env.kind) {
    case 'text':
      return formatMentionsForPreview(env.text);
    case 'media':
      return env.caption ? `[Media] ${formatMentionsForPreview(env.caption)}` : '[Media]';
    case 'system':
      return `[Info] ${formatMentionsForPreview(env.text)}`;
  }
}

/** Parse a stored content string back into a MessageEnvelope. */
const envelopeCache = new Map<string, MessageEnvelope>();

/**
 * Parse a stored content string back into a typed MessageEnvelope.
 * Strings starting with `{` are treated as JSON and validated against each known variant.
 * Any string that is not valid JSON, or valid JSON that does not match a known envelope shape,
 * is returned as a `TextEnvelope` for backward compatibility with legacy plain-text messages.
 * Results are memoized in a bounded 2 000-entry LRU-style cache to avoid repeated parsing.
 */
export function parseEnvelope(content: string): MessageEnvelope {
  const cached = envelopeCache.get(content);
  if (cached) return cached;

  let result: MessageEnvelope;

  if (content.startsWith('{')) {
    try {
      const obj = JSON.parse(content) as Record<string, unknown>;

      const safeReplyTo = (v: unknown): MessageReference | undefined => {
        if (v && typeof v === 'object') {
          const r = v as Record<string, unknown>;
          if (
            typeof r.id === 'string' &&
            typeof r.senderId === 'string' &&
            typeof r.content === 'string'
          ) {
            return { id: r.id, senderId: r.senderId, content: r.content };
          }
        }
        return undefined;
      };

      if (obj.kind === 'text' && typeof obj.text === 'string') {
        return {
          kind: 'text',
          text: obj.text,
          replyTo: safeReplyTo(obj.replyTo),
        };
      }

      if (obj.kind === 'system' && typeof obj.text === 'string') {
        const ci = obj.channelInvite as Record<string, unknown> | undefined;
        const channelInvite =
          ci && typeof ci.channelId === 'string' && typeof ci.channelName === 'string'
            ? {
                channelId: ci.channelId,
                channelName: ci.channelName,
                workspaceName: typeof ci.workspaceName === 'string' ? ci.workspaceName : undefined,
              }
            : undefined;
        const ce = obj.callEvent as Record<string, unknown> | undefined;
        const callEvent =
          ce &&
          typeof ce.callId === 'string' &&
          typeof ce.starterId === 'string' &&
          typeof ce.startedAt === 'number'
            ? {
                callId: ce.callId,
                starterId: ce.starterId,
                startedAt: ce.startedAt,
              }
            : undefined;
        return {
          kind: 'system',
          text: obj.text,
          ...(channelInvite ? { channelInvite } : {}),
          ...(callEvent ? { callEvent } : {}),
        };
      }

      if (obj.kind === 'media' && typeof obj.media === 'object' && obj.media !== null) {
        const media = obj.media as Record<string, unknown>;
        if (
          (media.type === 'image' ||
            media.type === 'video' ||
            media.type === 'audio' ||
            media.type === 'file') &&
          typeof media.mediaId === 'string' &&
          typeof media.key === 'string' &&
          typeof media.iv === 'string'
        ) {
          return {
            kind: 'media',
            media: {
              type: media.type as MediaRef['type'],
              mediaId: media.mediaId,
              key: media.key,
              iv: media.iv,
              mimeType: typeof media.mimeType === 'string' ? media.mimeType : '',
              size: typeof media.size === 'number' ? media.size : 0,
              fileName: typeof media.fileName === 'string' ? media.fileName : undefined,
              width: typeof media.width === 'number' && media.width > 0 ? media.width : undefined,
              height:
                typeof media.height === 'number' && media.height > 0 ? media.height : undefined,
            },
            caption: typeof obj.caption === 'string' ? obj.caption : undefined,
            replyTo: safeReplyTo(obj.replyTo),
          };
        }
      }

      // Fallthrough to legacy on valid JSON that isn't a known envelope
      result = { kind: 'text', text: content };
    } catch {
      result = { kind: 'text', text: content };
    }
  } else {
    // Legacy plain-text or unknown - treat as text
    result = { kind: 'text', text: content };
  }

  // Cache strict bounds. Use LRU if needed, but for typical session usage,
  // 2000 items is reasonable.
  if (envelopeCache.size > 2000) {
    envelopeCache.clear();
  }
  envelopeCache.set(content, result);
  return result;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Build a text message envelope, optionally quoting another message as a reply. */
export function mkTextEnvelope(text: string, replyTo?: MessageReference): MessageEnvelope {
  return { kind: 'text', text, replyTo };
}

/** Build a media message envelope wrapping an encrypted attachment reference and an optional caption. */
export function mkMediaEnvelope(
  media: MediaRef,
  caption?: string,
  replyTo?: MessageReference
): MessageEnvelope {
  return { kind: 'media', media, caption, replyTo };
}

/** Build a system / group-event envelope (e.g. "Alice renamed the group"). These are never user-authored. */
export function mkSystemEnvelope(text: string): MessageEnvelope {
  return { kind: 'system', text };
}

/** Build a channel-invite system envelope that the UI renders as an actionable Join card. */
export function mkChannelInviteEnvelope(
  channelId: string,
  channelName: string,
  workspaceName?: string
): SystemEnvelope {
  return {
    kind: 'system',
    text: `Invitation à rejoindre #${channelName}`,
    channelInvite: { channelId, channelName, workspaceName },
  };
}

/** Build a system envelope for a call that just started. */
export function mkCallStartedEnvelope(
  starterName: string,
  callId: string,
  starterId: string,
  startedAt: number = Date.now()
): SystemEnvelope {
  return {
    kind: 'system',
    text: `${starterName} a démarré un appel`,
    callEvent: { callId, starterId, startedAt },
  };
}

/** Returns the system text after a call ends, including its duration. */
export function buildCallEndedText(starterName: string, durationMs: number): string {
  return `${starterName} a démarré un appel qui a duré ${formatCallDuration(durationMs)}`;
}

/** Formats a call duration for display in French. */
export function formatCallDuration(durationMs: number): string {
  const minutes = Math.floor(Math.max(0, durationMs) / 60_000);
  if (minutes < 1) return "moins d'une minute";
  if (minutes === 1) return '1 minute';
  return `${minutes} minutes`;
}
