/**
 * THE LOCAL MESSAGE INDEX: the text of every message this device holds, decrypted into MEMORY ONLY,
 * for the universal search's Discussions section (owner, 2026-11-26).
 *
 * WHY IN MEMORY AND NEVER ON DISK. The message store is sealed at rest with the device key
 * (`db/types.ts`, `EncryptedMessageRow`); a plaintext index written beside it would undo that seal for
 * every word of every conversation. So the index is built by reading the store through its own
 * decrypting reads, lives in this realm's memory while the search is open, and is dropped when the
 * search closes and at every sign-out ({@link discardLocalMessageIndex}, called by `clearAuth`).
 * Nothing in it ever leaves the device - charter principle 1, "vos messages sont à vous".
 *
 * HOW IT STAYS TRUE WITHOUT A CLOCK. It reads each conversation once, then re-reads ONLY the
 * conversations a write named since (`db/messageWrites.ts`, the seam every store write of this realm
 * crosses) - and a conversation written WHILE it was being read stays marked, so the next refresh
 * reads it again. No timer decides anything: a refresh is asked by the search, and ends when its pass
 * over the conversations it was given ends.
 *
 * WHAT IT COSTS. One AES-GCM decrypt per stored message on the first refresh (the same read the
 * in-conversation search already does for one conversation), then a substring scan per query over
 * folded text (no allocation per message). Conversations are read one at a time, newest first, and
 * the work yields between them, so a store of any size is read without one long frame, and the first
 * hits come from the conversations most likely to matter. `docs/wiki/frontend/universal-search.md`
 * has the measurement and what bounds it.
 */
import type { StoredMessage } from '$lib/db/types';
import { parseEnvelope } from '$lib/envelope';
import { formatMentionsForPreview } from '$lib/utils/mentions.parse';
import { foldForSearch } from '$lib/utils/textFold';
import { subscribeMessageWrites, type TouchedConversations } from '$lib/db/messageWrites';
import { discardLocalMessageIndex, openIndex, registerIndex } from './localIndexRegistry';
import { yieldToMainThread } from '$lib/utils/scheduling/yieldToMainThread';
import { containsEveryToken, type FoldedQuery } from './rank';

/** Where the index reads from: the device's store, for the conversations it is told to cover. */
export interface MessageIndexSource {
  /** The direct and group conversations to cover, most recent first. Salons are not stored here. */
  conversationIds(): Promise<string[]>;
  /** Every message of one conversation, decrypted (`IStorage.getMessages`). */
  readMessages(conversationId: string): Promise<StoredMessage[]>;
}

/** One message as the index keeps it. */
export interface IndexedMessage {
  id: string;
  conversationId: string;
  senderId: string;
  /** Creation time, Unix ms. */
  at: number;
  /** The words a reader sees in the bubble (text, a caption, a poll's question). */
  text: string;
  /** {@link IndexedMessage.text} folded, matched against. */
  folded: string;
}

/** How far a refresh has gone: conversations read out of those to read. */
export interface IndexProgress {
  read: number;
  total: number;
}

/**
 * The searchable words of a stored message, or `null` when it has none a reader would search for:
 * a deleted message (its text is gone), a notice ("X a ajouté Y", drawn by the app, not written by
 * anyone), or a media with no caption.
 */
export function indexableText(msg: StoredMessage): string | null {
  if (msg.isDeleted) return null;
  const env = parseEnvelope(msg.content);
  switch (env.kind) {
    case 'text':
      return formatMentionsForPreview(env.text);
    case 'media':
      return env.caption ? formatMentionsForPreview(env.caption) : null;
    case 'poll':
      return env.question;
    case 'system':
      return null;
  }
}

export class LocalMessageIndex {
  private readonly byConversation = new Map<string, IndexedMessage[]>();
  /** Conversations a write named since they were last read. */
  private readonly dirty = new Set<string>();
  /** A write named no conversation (`clear`, a retention sweep): everything is read again. */
  private allDirty = false;
  private refreshing: Promise<void> | null = null;
  private discarded = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly source: MessageIndexSource,
    private readonly log: (line: string) => void,
    private readonly onChanged: () => void = () => {}
  ) {
    this.unsubscribe = subscribeMessageWrites((touched) => this.noteWrite(touched));
  }

  /** How many messages the index holds now. */
  get size(): number {
    let n = 0;
    for (const rows of this.byConversation.values()) n += rows.length;
    return n;
  }

  /** Marks what a write changed, so the next refresh reads it again; tells the owner once. */
  noteWrite(touched: TouchedConversations): void {
    if (this.discarded) return;
    if (touched === 'all') this.allDirty = true;
    else for (const id of touched) this.dirty.add(id);
    this.onChanged();
  }

  /**
   * Brings the index up to date: reads every covered conversation it does not hold, and every one a
   * write named since its last read; forgets the conversations no longer covered. Single-flight: a
   * second caller joins the pass under way, and a write made during it is read by the NEXT pass.
   */
  refresh(onProgress?: (p: IndexProgress) => void): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.runRefresh(onProgress).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async runRefresh(onProgress?: (p: IndexProgress) => void): Promise<void> {
    const ids = await this.source.conversationIds();
    if (this.discarded) return;
    const covered = new Set(ids);
    for (const id of this.byConversation.keys()) {
      if (!covered.has(id)) this.byConversation.delete(id);
    }
    if (this.allDirty) {
      this.allDirty = false;
      this.byConversation.clear();
      this.dirty.clear();
    }
    const toRead = ids.filter((id) => !this.byConversation.has(id) || this.dirty.has(id));
    const started = Date.now();
    let failed = 0;
    for (let i = 0; i < toRead.length; i++) {
      const id = toRead[i];
      // Cleared BEFORE the read: a write landing during it marks the conversation again.
      this.dirty.delete(id);
      try {
        const rows = await this.source.readMessages(id);
        if (this.discarded) return;
        this.byConversation.set(id, toIndexed(rows));
      } catch (e) {
        // That conversation is searched by none of its messages until the next refresh reads it.
        failed++;
        this.dirty.add(id);
        console.error(
          `[SEARCH] the local index could not read conversation ${id.slice(0, 8)}: ${String(e).slice(0, 200)}`
        );
      }
      onProgress?.({ read: i + 1, total: toRead.length });
      if (i < toRead.length - 1) await yieldToMainThread();
      if (this.discarded) return;
    }
    if (toRead.length > 0) {
      this.log(
        `[SEARCH] local index: ${toRead.length - failed}/${toRead.length} conversation(s) read in ${Date.now() - started} ms, ${this.size} message(s) held`
      );
    }
  }

  /**
   * The messages holding every typed word, newest first, and how many there are in all. Reads what
   * the index holds now; a caller wanting the latest writes refreshes first.
   */
  search(query: FoldedQuery, limit: number): { hits: IndexedMessage[]; total: number } {
    const hits: IndexedMessage[] = [];
    for (const rows of this.byConversation.values()) {
      for (const row of rows) if (containsEveryToken(row.folded, query)) hits.push(row);
    }
    hits.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    return { hits: hits.slice(0, limit), total: hits.length };
  }

  /** Forgets every message and stops listening. The index answers nothing afterwards. */
  discard(): void {
    this.discarded = true;
    this.unsubscribe();
    this.byConversation.clear();
    this.dirty.clear();
  }

  /** Whether {@link discard} ran. */
  get isDiscarded(): boolean {
    return this.discarded;
  }
}

function toIndexed(rows: readonly StoredMessage[]): IndexedMessage[] {
  const out: IndexedMessage[] = [];
  for (const row of rows) {
    const text = indexableText(row);
    if (!text) continue;
    out.push({
      id: row.id,
      conversationId: row.conversationId,
      senderId: row.senderId,
      at: row.timestamp,
      text,
      folded: foldForSearch(text),
    });
  }
  return out;
}

/**
 * The index for `source`, opened if none is: ONE per realm (`localIndexRegistry.ts`), so the search
 * page and its sections share the same decrypted copy rather than each reading the store.
 */
export function openLocalMessageIndex(
  source: MessageIndexSource,
  log: (line: string) => void,
  onChanged?: () => void
): LocalMessageIndex {
  const open = openIndex();
  if (open instanceof LocalMessageIndex) return open;
  const index = new LocalMessageIndex(source, log, onChanged);
  registerIndex(index);
  return index;
}

export { discardLocalMessageIndex };
