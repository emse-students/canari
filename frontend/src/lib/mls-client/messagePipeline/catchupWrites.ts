/**
 * THE STORE WRITES A CATCH-UP BATCHES (2026-11-28): a reaction frame's write onto its stored row,
 * and the save of a conversation row a peer's read mark moved. Each cost one store round trip per
 * frame (~75 ms and ~65 ms on the owner's Android, 148 frames in ~10 s) while the texts of the same
 * drain were already written once, at the window's close.
 *
 * **THE MECHANISM IS THE TEXTS' OWN** ([chat](docs/wiki/frontend/modules/chat.md#a-catch-up-lands-in-one-render-2026-11-24)):
 * while a UI-buffering window is open, the frame's handler hands its write to this ledger instead of
 * awaiting it. The window's CLOSE (`onBulkIngestEnd`, the drain's own completion - no clock) writes
 * everything held, once per conversation; a checkpoint's hold writes it first (rows before ratchet),
 * and until a write lands its frame is in {@link CatchupWrites.framesLeftUnstored}, so the ack never
 * runs ahead of the disk.
 *
 * **THE FINAL STATE IS TODAY'S, AND SO IS THE ORDER:**
 * - a reaction is folded onto the row AS THE STORE HOLDS IT at the write (`mergeMessages`, a
 *   compare-and-set), and a batch folds a row's reactions in FRAME ORDER, so the row ends as the
 *   per-frame writes left it; `applyReaction` is idempotent per (sender, emoji) rank, so a replay
 *   changes nothing;
 * - a conversation save writes the row as memory holds it at the flush, which is the row the LAST
 *   per-frame save would have written (every handler updates memory before it hands the save over);
 * - the two touch different tables, so neither orders against the other.
 *
 * Registered by `setupMessageHandler` BEFORE the UI render buffer's observer, so on every close and
 * every hold these writes land before the buffered rows' store, as the per-frame writes did.
 */
import type { IStorage, StoredMessage } from '$lib/db/types';
import type { Conversation } from '$lib/types';
import { movedKeyOf } from '$lib/utils/chat/conversationMoves';
import type { BulkIngestObserver, BulkIngestPhase } from '../IMlsService';

/** How one reaction folds onto the stored row, a pure function of the row (`mergeMessages`). */
export type StoredRowFold = (current: StoredMessage) => StoredMessage | null;

/** One reaction write a frame handed over. */
export interface DeferredReaction {
  convoKey: string;
  messageId: string;
  fold: StoredRowFold;
  /** The queued frame this write belongs to, whose ack waits for it. */
  frameId?: string;
  /** What the per-frame path did when its write threw: keep the reaction as a pending mutation. */
  park: (cause: unknown) => Promise<void>;
}

/** What the ledger reads and writes. */
export interface CatchupWritesDeps {
  storage: IStorage | null;
  deviceKey: () => string;
  conversations: { get(key: string): Conversation | undefined };
  saveConversation: (key: string) => Promise<void>;
  log: (msg: string) => void;
}

/** The ledger: a bulk-ingest observer (open/close/hold/ledger of unstored frames) plus its intake. */
export interface CatchupWrites extends Required<BulkIngestObserver> {
  /** Whether a write handed over now is held for the window's close (a window is open, no hold). */
  deferring(): boolean;
  /** Holds a reaction's write onto its stored row for the next flush. */
  deferReaction(entry: DeferredReaction): void;
  /** Holds the save of a conversation row whose in-memory state a frame just changed. */
  deferConversationSave(convoKey: string, frameId?: string): void;
}

/**
 * Creates the ledger of one session.
 *
 * @returns the observer to register on the MLS service, and the intake the handlers write through
 */
export function createCatchupWrites(deps: CatchupWritesDeps): CatchupWrites {
  const { log } = deps;
  /** UI-buffering windows open now - a COUNT, like the render buffer's. */
  let openWindows = 0;
  /** Checkpoint holds standing: while any, nothing is held back (its advance may be exported). */
  let holds = 0;
  const reactions: DeferredReaction[] = [];
  /** Conversations whose save is owed, with the frames behind each. Insertion order = first mark. */
  const saves = new Map<string, Set<string>>();
  /** Frames of the writes a flush took and has not landed yet. */
  const inFlight = new Map<string, number>();
  let chain: Promise<void> = Promise.resolve();

  /** Where a thread lives NOW: its key, else where a Welcome moved it, else nowhere. */
  const homeOf = (key: string): string | null => {
    if (deps.conversations.get(key)) return key;
    const moved = movedKeyOf(key);
    return moved !== null && deps.conversations.get(moved) ? moved : null;
  };

  const track = (frames: Iterable<string>, delta: 1 | -1) => {
    for (const id of frames) {
      const next = (inFlight.get(id) ?? 0) + delta;
      if (next <= 0) inFlight.delete(id);
      else inFlight.set(id, next);
    }
  };

  /** One conversation's reactions in ONE merge, each row folded in frame order. */
  async function writeReactions(convoKey: string, entries: DeferredReaction[]): Promise<void> {
    const { storage } = deps;
    if (!storage) return;
    const home = homeOf(convoKey);
    if (home === null) {
      log(
        `[CATCHUP_WRITES] ${entries.length} reaction(s) for ${convoKey.slice(0, 8)}… dropped: no conversation shows that thread any more`
      );
      return;
    }
    const folds = new Map<string, StoredRowFold[]>();
    for (const entry of entries) {
      const list = folds.get(entry.messageId) ?? [];
      list.push(entry.fold);
      folds.set(entry.messageId, list);
    }
    try {
      const written = await storage.mergeMessages(
        home,
        [...folds.keys()],
        (current) => {
          let row = current;
          for (const fold of folds.get(current.id) ?? []) row = fold(row) ?? row;
          return row === current ? null : row;
        },
        deps.deviceKey()
      );
      log(
        `[CATCHUP_WRITES] ${entries.length} reaction(s) on ${folds.size} message(s) of ${home.slice(0, 8)}… written in one merge (${written.size} row(s) changed)`
      );
    } catch (e) {
      // What the per-frame path did for each frame: KEPT as a pending mutation, never only logged.
      console.error(
        `[CATCHUP_WRITES] the merge of ${entries.length} reaction(s) into ${home.slice(0, 8)}… threw - each is kept as a pending mutation:`,
        e
      );
      for (const entry of entries) {
        try {
          await entry.park(e);
        } catch (parkError) {
          console.error(
            `[CATCHUP_WRITES] a reaction on ${entry.messageId.slice(0, 8)} could not be parked either:`,
            parkError
          );
        }
      }
    }
  }

  /** Writes everything held, once per conversation. Never rejects. */
  function flush(origin: 'close' | 'hold'): Promise<void> {
    chain = chain
      .then(async () => {
        if (reactions.length === 0 && saves.size === 0) return;
        const takenReactions = reactions.splice(0);
        const takenSaves = new Map(saves);
        saves.clear();
        const frames = [
          ...takenReactions.flatMap((r) => (r.frameId ? [r.frameId] : [])),
          ...[...takenSaves.values()].flatMap((s) => [...s]),
        ];
        track(frames, 1);
        try {
          log(
            `[CATCHUP_WRITES] ${origin}: ${takenReactions.length} reaction(s) and ${takenSaves.size} conversation save(s) to write`
          );
          const byConvo = new Map<string, DeferredReaction[]>();
          for (const entry of takenReactions) {
            const list = byConvo.get(entry.convoKey) ?? [];
            list.push(entry);
            byConvo.set(entry.convoKey, list);
          }
          for (const [convoKey, entries] of byConvo) await writeReactions(convoKey, entries);
          for (const [convoKey, ids] of takenSaves) {
            const home = homeOf(convoKey);
            if (home === null) {
              log(
                `[CATCHUP_WRITES] save of ${convoKey.slice(0, 8)}… dropped: the conversation left the map during the window`
              );
              continue;
            }
            try {
              await deps.saveConversation(home);
            } catch (e) {
              // KEPT for the next flush, its frames' acks withheld: it is idempotent, and swallowing
              // it (what the per-frame path did) lost the read mark for good.
              console.error(
                `[CATCHUP_WRITES] saving ${home.slice(0, 8)}… failed - kept for the next flush:`,
                e
              );
              const kept = saves.get(convoKey) ?? new Set<string>();
              for (const id of ids) kept.add(id);
              saves.set(convoKey, kept);
            }
          }
        } finally {
          track(frames, -1);
        }
      })
      .catch((e: unknown) => {
        console.error(`[CATCHUP_WRITES] a flush threw (${origin}):`, e);
      });
    return chain;
  }

  return {
    deferring: () => openWindows > 0 && holds === 0,
    deferReaction(entry) {
      reactions.push(entry);
    },
    deferConversationSave(convoKey, frameId) {
      const frames = saves.get(convoKey) ?? new Set<string>();
      if (frameId) frames.add(frameId);
      saves.set(convoKey, frames);
    },
    onBulkIngestStart(phase: BulkIngestPhase) {
      if (phase.bufferUi) openWindows += 1;
    },
    async onBulkIngestEnd(phase: BulkIngestPhase) {
      if (!phase.bufferUi) return;
      if (openWindows > 0) openWindows -= 1;
      // Written at EVERY close, not only the last: what an earlier window held waits for no one.
      await flush('close');
    },
    async holdRowsForCheckpoint() {
      holds += 1;
      await flush('hold');
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
      };
    },
    framesLeftUnstored() {
      const frames = new Set<string>(inFlight.keys());
      for (const r of reactions) if (r.frameId) frames.add(r.frameId);
      for (const ids of saves.values()) for (const id of ids) frames.add(id);
      return frames;
    },
  };
}
