/**
 * envelope.ts — Unified message envelope for all chat message types.
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
}

export type MessageEnvelope = TextEnvelope | MediaEnvelope | SystemEnvelope;

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

export function serializeEnvelope(env: MessageEnvelope): string {
  return JSON.stringify(env);
}

/**
 * Returns a short preview string suitable for lists or reply contexts.
 */
export function getPreviewText(env: MessageEnvelope): string {
  switch (env.kind) {
    case 'text':
      return env.text;
    case 'media':
      return env.caption ? `[Media] ${env.caption}` : '[Media]';
    case 'system':
      return `[Info] ${env.text}`;
  }
}

/** Parse a stored content string back into a MessageEnvelope. */
const envelopeCache = new Map<string, MessageEnvelope>();

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
        return { kind: 'system', text: obj.text };
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
    // Legacy plain-text or unknown — treat as text
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

export function mkTextEnvelope(text: string, replyTo?: MessageReference): MessageEnvelope {
  return { kind: 'text', text, replyTo };
}

export function mkMediaEnvelope(
  media: MediaRef,
  caption?: string,
  replyTo?: MessageReference
): MessageEnvelope {
  return { kind: 'media', media, caption, replyTo };
}

export function mkSystemEnvelope(text: string): MessageEnvelope {
  return { kind: 'system', text };
}
