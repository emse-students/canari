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
import { extractFirstUrl, isGifUrl } from '$lib/utils/chat/messageDisplay';
import { m } from '$lib/paraglide/messages';

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
    /**
     * Set once the call has ended and its duration has been baked into `text`.
     * Presence of this field (not the display text) is what marks a call message
     * as finalized, so the "ended" state survives translation of `text`.
     */
    endedAt?: number;
  };
}

/**
 * Community poll. Holds only the end-to-end-encrypted definition (question +
 * option labels); the live tally is tracked separately in the poll store, keyed
 * by message id, since it changes after the message is serialized.
 */
export interface PollEnvelope {
  kind: 'poll';
  question: string;
  options: { id: string; label: string }[];
  multipleChoice: boolean;
  /** ISO date or null for no deadline. */
  endsAt: string | null;
}

export type MessageEnvelope = TextEnvelope | MediaEnvelope | SystemEnvelope | PollEnvelope;

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
      return previewForTextMessage(env.text);
    case 'media':
      return env.caption
        ? `${m.chat_preview_media()} ${formatMentionsForPreview(env.caption)}`
        : m.chat_preview_media();
    case 'system':
      return `${m.chat_preview_info()} ${formatMentionsForPreview(env.text)}`;
    case 'poll':
      return `${m.chat_preview_poll()} ${env.question}`;
  }
}

/**
 * Builds the list/reply preview for a text message. A message whose entire body is a single
 * link is shown with a friendly label instead of the raw URL: `[GIF]` for animated GIFs, and
 * `[Lien] <domaine>` for any other recognised link, so the conversation list never shows the
 * beginning of a long URL.
 */
function previewForTextMessage(text: string): string {
  const trimmed = text.trim();
  const url = extractFirstUrl(trimmed);
  if (url && trimmed === url) {
    if (isGifUrl(url)) return m.chat_preview_gif();
    try {
      return `${m.chat_preview_link()} ${new URL(url).hostname.replace(/^www\./, '')}`;
    } catch {
      return m.chat_preview_link();
    }
  }
  return formatMentionsForPreview(text);
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
                ...(typeof ce.endedAt === 'number' ? { endedAt: ce.endedAt } : {}),
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

      if (obj.kind === 'poll' && typeof obj.question === 'string' && Array.isArray(obj.options)) {
        const options = (obj.options as unknown[])
          .map((o) => {
            const r = o as Record<string, unknown>;
            return typeof r?.id === 'string' && typeof r?.label === 'string'
              ? { id: r.id, label: r.label }
              : null;
          })
          .filter((o): o is { id: string; label: string } => o !== null);
        if (options.length >= 2) {
          return {
            kind: 'poll',
            question: obj.question,
            options,
            multipleChoice: obj.multipleChoice === true,
            endsAt: typeof obj.endsAt === 'string' ? obj.endsAt : null,
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

/** Build a poll envelope from a decoded PollMsg (the live tally is stored separately). */
export function mkPollEnvelope(
  question: string,
  options: { id: string; label: string }[],
  multipleChoice: boolean,
  endsAt: string | null
): PollEnvelope {
  return { kind: 'poll', question, options, multipleChoice, endsAt };
}

/** Build a channel-invite system envelope that the UI renders as an actionable Join card. */
export function mkChannelInviteEnvelope(
  channelId: string,
  channelName: string,
  workspaceName?: string
): SystemEnvelope {
  return {
    kind: 'system',
    text: m.chat_system_channel_invite({ channel: channelName }),
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
    text: m.chat_system_call_started({ starter: starterName }),
    callEvent: { callId, starterId, startedAt },
  };
}

/** Returns the system text after a call ends, including its duration. */
export function buildCallEndedText(starterName: string, durationMs: number): string {
  return m.chat_system_call_ended({
    starter: starterName,
    duration: formatCallDuration(durationMs),
  });
}

/** Formats a call duration for display, localized to the active locale. */
export function formatCallDuration(durationMs: number): string {
  const minutes = Math.floor(Math.max(0, durationMs) / 60_000);
  if (minutes < 1) return m.chat_system_call_duration_under_minute();
  if (minutes === 1) return m.chat_system_call_duration_one_minute();
  return m.chat_system_call_duration_minutes({ count: minutes });
}
