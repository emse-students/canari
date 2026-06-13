import { parseEnvelope } from '$lib/envelope';
import type { MediaRef } from '$lib/media';

/**
 * Aggregates the media, files and links shared in a conversation from its full
 * (decrypted) local message history, for the "Médias, liens & fichiers" panel.
 * Pure over already-decrypted message content - works the same for DMs, groups
 * and community channels.
 */

export interface SharedMediaItem {
  messageId: string;
  senderId: string;
  timestamp: number;
  media: MediaRef;
  caption?: string;
}

export interface SharedLinkItem {
  messageId: string;
  senderId: string;
  timestamp: number;
  url: string;
}

export interface SharedContent {
  /** Images and videos (visual grid). */
  media: SharedMediaItem[];
  /** Audio and generic file attachments (list). */
  files: SharedMediaItem[];
  /** URLs found in text messages and media captions. */
  links: SharedLinkItem[];
}

/** Minimal message shape needed for aggregation (matches StoredMessage / ChatMessage). */
export interface AggregatableMessage {
  id: string;
  senderId: string;
  timestamp: number;
  content: string;
  isDeleted?: boolean;
}

/** Matches http(s) URLs; trailing punctuation is trimmed so "(see https://x.)" yields a clean URL. */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function extractUrls(text: string): string[] {
  const matches = text.match(URL_RE);
  if (!matches) return [];
  return matches.map((u) => u.replace(/[.,;:!?)\]}'"]+$/, ''));
}

/** Builds the shared-content lists from a conversation's messages, newest first. */
export function aggregateSharedContent(messages: AggregatableMessage[]): SharedContent {
  const media: SharedMediaItem[] = [];
  const files: SharedMediaItem[] = [];
  const links: SharedLinkItem[] = [];

  for (const m of messages) {
    if (m.isDeleted) continue;
    let env;
    try {
      env = parseEnvelope(m.content);
    } catch {
      continue;
    }

    if (env.kind === 'media') {
      const item: SharedMediaItem = {
        messageId: m.id,
        senderId: m.senderId,
        timestamp: m.timestamp,
        media: env.media,
        caption: env.caption,
      };
      if (env.media.type === 'image' || env.media.type === 'video') media.push(item);
      else files.push(item);
      if (env.caption) {
        for (const url of extractUrls(env.caption)) {
          links.push({ messageId: m.id, senderId: m.senderId, timestamp: m.timestamp, url });
        }
      }
    } else if (env.kind === 'text') {
      for (const url of extractUrls(env.text)) {
        links.push({ messageId: m.id, senderId: m.senderId, timestamp: m.timestamp, url });
      }
    }
  }

  const byNewest = (a: { timestamp: number }, b: { timestamp: number }) =>
    b.timestamp - a.timestamp;
  media.sort(byNewest);
  files.sort(byNewest);
  links.sort(byNewest);
  return { media, files, links };
}
