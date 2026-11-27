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
 * HOW IT STAYS TRUE WITHOUT A CLOCK. It reads each conversation once, then re-reads ONLY the rows a
 * write named since (`db/messageWrites.ts`, the seam every store write of this realm crosses), so a
 * new message in a conversation of any size costs one row, never its history again. A write landing
 * WHILE a pass runs is read by the next pass, and the passes loop until one meets no new write. No
 * timer decides anything: a pass ends when its list of conversations ends.
 *
 * IT ANSWERS WHILE IT FILLS. A search reads what the index holds NOW and says whether it is still
 * {@link LocalMessageIndex.filling}; the index tells the search again after 1, 2, 4, 8...
 * conversations and once its passes end - so the conversation names show at once, and the message
 * matches arrive as the index fills, with O(log n) re-runs and no clock.
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
  /**
   * The rows of one conversation stored under `ids` NOW, decrypted (`IStorage.getMessagesByIds`): an
   * id absent from the answer is a row no longer stored there (deleted, or moved away).
   */
  readMessagesByIds(conversationId: string, ids: readonly string[]): Promise<StoredMessage[]>;
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

/** What writes left to read again in one conversation: the message ids they named, or all of it. */
type Pending = Set<string> | 'all';

/** Whether the `n`th step of a pass tells the search: 1, 2, 4, 8... - O(log n) re-runs, no clock. */
function isMilestone(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export class LocalMessageIndex {
  /** The indexed messages of every conversation read, by message id. */
  private readonly byConversation = new Map<string, Map<string, IndexedMessage>>();
  /** What writes named since each conversation was last read. */
  private pending = new Map<string, Pending>();
  /** A write named no conversation (`clear`, a retention sweep, a re-seal): everything is read again. */
  private allDirty = false;
  /** Conversations whose last read failed: searched by none of their messages until a pass reads them. */
  private readonly failed = new Set<string>();
  /** Whether a pass ever completed. */
  private passed = false;
  /** Whether the search was given an answer while the index was still filling (it is owed another). */
  private answeredWhileFilling = false;
  private refreshing: Promise<void> | null = null;
  private discarded = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly source: MessageIndexSource,
    private readonly log: (line: string) => void,
    private onChanged: () => void = () => {}
  ) {
    this.unsubscribe = subscribeMessageWrites((touched) => this.noteWrite(touched));
  }

  /** Who is told when the index holds something new (the open search's Discussions section). */
  setOnChanged(onChanged: () => void): void {
    this.onChanged = onChanged;
  }

  /** How many messages the index holds now. */
  get size(): number {
    let n = 0;
    for (const rows of this.byConversation.values()) n += rows.size;
    return n;
  }

  /** Whether a write was noted that no pass has read yet, or no pass ever completed. */
  private get needsPass(): boolean {
    return !this.passed || this.allDirty || this.pending.size > 0;
  }

  /**
   * Whether the index holds less than the store does: no pass yet, a pass under way, or a write not
   * read yet. An answer given meanwhile is partial, and the search is told again once it is not.
   */
  get filling(): boolean {
    return !this.discarded && (this.refreshing !== null || this.needsPass);
  }

  /**
   * Whether a pass would read something for `conversationIds`: a write not read yet, or a covered
   * conversation never read (a new one) - but not one whose read just failed, which a write retries.
   */
  wants(conversationIds: readonly string[]): boolean {
    if (this.discarded) return false;
    if (this.needsPass) return true;
    return conversationIds.some((id) => !this.byConversation.has(id) && !this.failed.has(id));
  }

  /**
   * Marks what a write changed. Once the index was asked for, the write starts the pass that reads it
   * (or is read by the passes under way, which loop until no write is left).
   */
  noteWrite(touched: TouchedConversations): void {
    if (this.discarded) return;
    if (touched === 'all') this.allDirty = true;
    else {
      for (const { conversationId, ids } of touched) {
        const had = this.pending.get(conversationId);
        if (ids === 'all' || had === 'all') {
          this.pending.set(conversationId, 'all');
          continue;
        }
        const next = had ?? new Set<string>();
        for (const id of ids) next.add(id);
        this.pending.set(conversationId, next);
      }
    }
    if (this.passed || this.refreshing) {
      this.refresh().catch((e: unknown) =>
        console.error(`[SEARCH] the local index could not read a write: ${String(e).slice(0, 200)}`)
      );
    }
  }

  /**
   * Brings the index up to date: reads every covered conversation it does not hold, re-reads the
   * ROWS a write named since (a conversation of any size costs the rows written, never its whole
   * history again), and forgets the conversations no longer covered. Single-flight: a second caller
   * joins the passes under way, and they loop until a pass met no new write - work proportional to
   * the writes, never a clock.
   */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.runPasses().then(
      (tell) => {
        this.refreshing = null;
        // Told once the passes are over, so the answer it asks for no longer reads as filling.
        if (tell && !this.discarded) this.onChanged();
      },
      (e: unknown) => {
        this.refreshing = null;
        throw e;
      }
    );
    return this.refreshing;
  }

  /** The passes, until none is owed; whether the search must be told (the last word). */
  private async runPasses(): Promise<boolean> {
    let changed = false;
    do {
      changed = (await this.runPass()) || changed;
    } while (!this.discarded && (this.allDirty || this.pending.size > 0));
    if (this.discarded) return false;
    const tell = changed || this.answeredWhileFilling;
    this.answeredWhileFilling = false;
    return tell;
  }

  /** One pass; whether it changed what the index holds. */
  private async runPass(): Promise<boolean> {
    const ids = await this.source.conversationIds();
    if (this.discarded) return false;
    // Taken at the START: a write landing during the pass is in the next map, read by the next pass.
    const noted = this.pending;
    this.pending = new Map();
    let changed = false;
    if (this.allDirty) {
      this.allDirty = false;
      changed = this.byConversation.size > 0;
      this.byConversation.clear();
    }
    const covered = new Set(ids);
    // Deleting the entry being visited is safe in a Map iteration.
    for (const id of this.byConversation.keys()) {
      if (covered.has(id)) continue;
      this.byConversation.delete(id);
      changed = true;
    }
    const work: { id: string; rows: readonly string[] | 'all' }[] = [];
    for (const id of ids) {
      const note = noted.get(id);
      if (!this.byConversation.has(id) || note === 'all') work.push({ id, rows: 'all' });
      else if (note) work.push({ id, rows: [...note] });
    }
    this.passed = true;
    if (work.length === 0) return changed;
    const started = Date.now();
    let failures = 0;
    let whole = 0;
    for (let i = 0; i < work.length; i++) {
      const { id, rows } = work[i];
      try {
        if (rows === 'all') {
          whole++;
          const read = await this.source.readMessages(id);
          if (this.discarded) return false;
          this.byConversation.set(id, toIndexed(id, read));
        } else {
          const read = await this.source.readMessagesByIds(id, rows);
          if (this.discarded) return false;
          const held = this.byConversation.get(id) ?? new Map<string, IndexedMessage>();
          // An id the store no longer answers was deleted or moved away: it is forgotten.
          for (const row of rows) held.delete(row);
          for (const [rowId, msg] of toIndexed(id, read)) held.set(rowId, msg);
          this.byConversation.set(id, held);
        }
        this.failed.delete(id);
      } catch (e) {
        // NONE of its messages rather than rows a write may have deleted since; a write retries it.
        failures++;
        this.byConversation.delete(id);
        this.failed.add(id);
        console.error(
          `[SEARCH] the local index could not read conversation ${id.slice(0, 8)}: ${String(e).slice(0, 200)}`
        );
      }
      changed = true;
      if (i < work.length - 1) {
        if (isMilestone(i + 1)) this.onChanged();
        await yieldToMainThread();
        if (this.discarded) return false;
      }
    }
    this.log(
      `[SEARCH] local index: ${work.length - failures}/${work.length} conversation(s) read (${whole} whole) in ${Date.now() - started} ms, ${this.size} message(s) held`
    );
    return changed;
  }

  /**
   * The messages holding every typed word, newest first, and how many there are in all. Reads what
   * the index holds now; while it is still {@link filling}, the search is told again once it is not.
   */
  search(query: FoldedQuery, limit: number): { hits: IndexedMessage[]; total: number } {
    if (this.filling) this.answeredWhileFilling = true;
    const hits: IndexedMessage[] = [];
    for (const rows of this.byConversation.values()) {
      for (const row of rows.values()) if (containsEveryToken(row.folded, query)) hits.push(row);
    }
    hits.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    return { hits: hits.slice(0, limit), total: hits.length };
  }

  /** Forgets every message and stops listening. The index answers nothing afterwards. */
  discard(): void {
    this.discarded = true;
    this.unsubscribe();
    this.byConversation.clear();
    this.pending.clear();
    this.failed.clear();
  }

  /** Whether {@link discard} ran. */
  get isDiscarded(): boolean {
    return this.discarded;
  }
}

/** The indexable rows of `conversationId` among `rows`, by id (a row of another one is not its). */
function toIndexed(
  conversationId: string,
  rows: readonly StoredMessage[]
): Map<string, IndexedMessage> {
  const out = new Map<string, IndexedMessage>();
  for (const row of rows) {
    if (row.conversationId !== conversationId) continue;
    const text = indexableText(row);
    if (!text) continue;
    out.set(row.id, {
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
 * `owner`'s index, opened if none is: ONE per realm (`localIndexRegistry.ts`), so the search page
 * and its sections share the same decrypted copy rather than each reading the store. An index held
 * for ANOTHER account is discarded first: an account never searches another's messages, even if a
 * switch reached here without a sign-out.
 */
export function openLocalMessageIndex(
  owner: string,
  source: MessageIndexSource,
  log: (line: string) => void,
  onChanged: () => void = () => {}
): LocalMessageIndex {
  const open = openIndex(owner);
  if (open instanceof LocalMessageIndex) {
    open.setOnChanged(onChanged);
    return open;
  }
  const index = new LocalMessageIndex(source, log, onChanged);
  registerIndex(index, owner);
  return index;
}

export { discardLocalMessageIndex };
