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
 * Parse a stored content string back into a MessageEnvelope.
 * Falls back to a plain TextEnvelope for legacy messages that were stored as
 * raw strings before the envelope format was introduced.
 */
export function parseEnvelope(content: string): MessageEnvelope {
  if (content.startsWith('{')) {
    try {
      const obj = JSON.parse(content);
      if (obj.kind === 'text' || obj.kind === 'media' || obj.kind === 'system') {
        return obj as MessageEnvelope;
      }
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
