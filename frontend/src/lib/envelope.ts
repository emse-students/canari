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

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export interface TextEnvelope {
  kind: 'text';
  text: string;
  replyTo?: { id: string; senderId: string; content: string };
}

export interface MediaEnvelope {
  kind: 'media';
  media: MediaRef;
  /** Optional text caption alongside the attachment. */
  caption?: string;
  replyTo?: { id: string; senderId: string; content: string };
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

/**
 * Parse a stored content string back into a MessageEnvelope.
 * Falls back to a plain TextEnvelope for legacy messages that were stored as
 * raw strings before the envelope format was introduced.
 */
export function parseEnvelope(content: string): MessageEnvelope {
  if (content.startsWith('{')) {
    try {
      const obj = JSON.parse(content) as Record<string, unknown>;
      if (obj.kind === 'text' && typeof obj.text === 'string') {
        return {
          kind: 'text',
          text: obj.text,
          replyTo:
            obj.replyTo && typeof obj.replyTo === 'object'
              ? (obj.replyTo as { id: string; senderId: string; content: string })
              : undefined,
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
            replyTo:
              obj.replyTo && typeof obj.replyTo === 'object'
                ? (obj.replyTo as { id: string; senderId: string; content: string })
                : undefined,
          };
        }
      }

      return { kind: 'system', text: '[Message mal encapsule ignore]' };
    } catch {
      // fall through to legacy
    }
  }
  // Legacy plain-text or unknown — treat as text
  return { kind: 'text', text: content };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function mkTextEnvelope(
  text: string,
  replyTo?: { id: string; senderId: string; content: string }
): MessageEnvelope {
  return { kind: 'text', text, replyTo };
}

export function mkMediaEnvelope(
  media: MediaRef,
  caption?: string,
  replyTo?: { id: string; senderId: string; content: string }
): MessageEnvelope {
  return { kind: 'media', media, caption, replyTo };
}

export function mkSystemEnvelope(text: string): MessageEnvelope {
  return { kind: 'system', text };
}
