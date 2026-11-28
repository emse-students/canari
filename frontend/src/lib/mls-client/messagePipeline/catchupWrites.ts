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
import { classifyRowWriteFailure } from '$lib/db/rowWriteFailure';
import { movedKeyOf } from '$lib/utils/chat/conversationMoves';
import type { BulkIngestObserver, BulkIngestPhase } from '../IMlsService';

/** How one reaction folds onto the stored row, a pure function of the row (`mergeMessages`). */
type StoredRowFold = (current: StoredMessage) => StoredMessage | null;

/** One reaction write a frame handed over. */
interface DeferredReaction {
  convoKey: string;
  messageId: string;
  fold: StoredRowFold;
  /** The queued frame this write belongs to, whose ack waits for it. */
  frameId?: string;
  /** What the per-frame path did when its write threw: keep the reaction as a pending mutation. */
  park: (cause: unknown) => Promise<void>;
}

/**
 * Held writes could not be written before a checkpoint: it is refused while they stand, and the
 * next one's hold writes them again (rows before ratchet).
 */
export class CatchupWritesNotStoredError extends Error {
  constructor(readonly writes: number) {
    super(
      `${writes} held write(s) of frames already applied did not land - the checkpoint must wait`
    );
    this.name = 'CatchupWritesNotStoredError';
  }
}

/**
 * Whether a failed conversation save can NEVER land: a value the store cannot clone
 * (`DataCloneError`), or a row refused for what it is (`classifyRowWriteFailure`, by TYPE). A bare
 * `DataError` is NOT read as permanent: `crypto.subtle.importKey` raises one for an empty device
 * key, which sign-in paths hand the store on purpose (`rowWriteFailure.ts`). Everything else is
 * transient, deliberately - withholding costs a re-listing, dropping costs the mark.
 */
function isPermanentSaveRefusal(e: unknown): boolean {
  return (
    classifyRowWriteFailure(e) === 'poison' ||
    (e as { name?: unknown } | null)?.name === 'DataCloneError'
  );
}

/** What the ledger reads and writes. */
export interface CatchupWritesDeps {
  storage: Pick<IStorage, 'getMessagesByIds' | 'mergeMessages'> | null;
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

  /**
   * THE INVARIANT OF EVERY CALLER: `deferring()` is asked and the write handed over with NO AWAIT
   * between the two. A hold (`holds`) or a close can begin at any await, flush, and return; a write
   * handed over after that would be covered by nobody while the checkpoint exports. The write is
   * still kept (the next flush or hold writes it, its frame withheld), but it is said at ERROR: it
   * means a caller put an await between the check and the hand-over.
   */
  const noteDeferredOutsideWindow = (what: string) => {
    if (openWindows > 0 && holds === 0) return;
    console.error(
      `[CATCHUP_WRITES] ${what} was handed over while no window was open or a checkpoint hold stood - a caller awaited between deferring() and the hand-over; held for the next flush`
    );
  };

  /** The cause that blocks checkpoints, said ONCE until every held write has landed. */
  let blockingSaid = false;

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

  /**
   * One conversation's reactions in ONE merge, each row folded in frame order.
   *
   * WHERE THE ROWS ARE, not where the thread is: a Welcome that re-keyed the thread moves its rows
   * with it, and a move that failed leaves them under the old key. Each key is asked which of the
   * rows it HOLDS (the thread's key now, then the key the frame named) and only those are merged -
   * a fold routed to a key that holds nothing would change 0 rows in silence.
   *
   * @returns the reactions that could neither be written nor parked: kept by the caller, never lost
   */
  async function writeReactions(
    convoKey: string,
    entries: DeferredReaction[]
  ): Promise<DeferredReaction[]> {
    const { storage } = deps;
    if (!storage) {
      // Nothing defers without a store (the handler returns first): reaching this is a defect.
      console.error(
        `[CATCHUP_WRITES] ${entries.length} reaction(s) for ${convoKey.slice(0, 8)}… held with no store to write them`
      );
      return entries;
    }
    const home = homeOf(convoKey);
    if (home === null) {
      log(
        `[CATCHUP_WRITES] ${entries.length} reaction(s) for ${convoKey.slice(0, 8)}… dropped: no conversation shows that thread any more`
      );
      return [];
    }
    const folds = new Map<string, StoredRowFold[]>();
    for (const entry of entries) {
      const list = folds.get(entry.messageId) ?? [];
      list.push(entry.fold);
      folds.set(entry.messageId, list);
    }
    try {
      let remaining = [...folds.keys()];
      let foldedRows = 0;
      let writtenRows = 0;
      for (const key of new Set([home, convoKey])) {
        if (remaining.length === 0) break;
        const found = await storage.getMessagesByIds(key, remaining, deps.deviceKey());
        const present = remaining.filter((id) => found.rows.has(id));
        if (present.length === 0) continue;
        const foldedIds = new Set<string>();
        const written = await storage.mergeMessages(
          key,
          present,
          (current) => {
            let row = current;
            for (const fold of folds.get(current.id) ?? []) row = fold(row) ?? row;
            if (row === current) return null;
            foldedIds.add(current.id);
            return row;
          },
          deps.deviceKey()
        );
        foldedRows += foldedIds.size;
        writtenRows += written.size;
        remaining = remaining.filter((id) => !present.includes(id));
      }
      if (foldedRows > writtenRows) {
        console.error(
          `[CATCHUP_WRITES] ${foldedRows} row(s) of ${home.slice(0, 8)}… changed by a reaction but only ${writtenRows} written - the store refused the rest`
        );
      }
      if (remaining.length > 0) {
        console.warn(
          `[CATCHUP_WRITES] ${remaining.length} message(s) reacted to in ${home.slice(0, 8)}… are in the store under no key this device knows - their reactions were not written (a row deleted since, or a failed move)`
        );
      }
      log(
        `[CATCHUP_WRITES] ${entries.length} reaction(s) on ${folds.size} message(s) of ${home.slice(0, 8)}… written in one merge (${writtenRows} row(s) changed)`
      );
      return [];
    } catch (e) {
      // What the per-frame path did for each frame: KEPT as a pending mutation, never only logged.
      console.error(
        `[CATCHUP_WRITES] the merge of ${entries.length} reaction(s) into ${home.slice(0, 8)}… threw - each is kept as a pending mutation:`,
        e
      );
      const unsettled: DeferredReaction[] = [];
      for (const entry of entries) {
        try {
          await entry.park(e);
        } catch (parkError) {
          console.error(
            `[CATCHUP_WRITES] a reaction on ${entry.messageId.slice(0, 8)} could not be parked either - held for the next flush:`,
            parkError
          );
          unsettled.push(entry);
        }
      }
      return unsettled;
    }
  }

  /** Writes everything held, once per conversation. Never rejects; what it could not write stays held. */
  function flush(origin: 'close' | 'hold'): Promise<void> {
    chain = chain
      .then(async () => {
        if (reactions.length === 0 && saves.size === 0) return;
        const takenReactions = reactions.splice(0);
        const takenSaves = new Map(saves);
        saves.clear();
        const byConvo = new Map<string, DeferredReaction[]>();
        for (const entry of takenReactions) {
          const list = byConvo.get(entry.convoKey) ?? [];
          list.push(entry);
          byConvo.set(entry.convoKey, list);
        }
        const frames = [
          ...takenReactions.flatMap((r) => (r.frameId ? [r.frameId] : [])),
          ...[...takenSaves.values()].flatMap((s) => [...s]),
        ];
        track(frames, 1);
        try {
          log(
            `[CATCHUP_WRITES] ${origin}: ${takenReactions.length} reaction(s) and ${takenSaves.size} conversation save(s) to write`
          );
          for (const [convoKey, entries] of byConvo) {
            const unsettled = await writeReactions(convoKey, entries);
            byConvo.delete(convoKey);
            reactions.push(...unsettled);
          }
          for (const [convoKey, ids] of takenSaves) {
            const home = homeOf(convoKey);
            if (home === null) {
              takenSaves.delete(convoKey);
              log(
                `[CATCHUP_WRITES] save of ${convoKey.slice(0, 8)}… dropped: the conversation left the map during the window`
              );
              continue;
            }
            try {
              await deps.saveConversation(home);
              takenSaves.delete(convoKey);
            } catch (e) {
              takenSaves.delete(convoKey);
              if (isPermanentSaveRefusal(e)) {
                // A value the store can NEVER take fails the same way at every retry and after every
                // reload: kept, it would refuse every checkpoint for good. Dropped, and accused.
                console.error(
                  `[CATCHUP_WRITES] the store refuses the row of ${home.slice(0, 8)}… for what it is (${String((e as { name?: unknown })?.name)}) - its held save is DROPPED, its frames acknowledged:`,
                  e
                );
                continue;
              }
              // KEPT for the next flush, its frames' acks withheld: it is idempotent, and swallowing
              // it (what the per-frame path did) lost the read mark for good. Said once per episode.
              if (!blockingSaid) {
                blockingSaid = true;
                console.error(
                  `[CATCHUP_WRITES] saving ${home.slice(0, 8)}… failed - kept, and every checkpoint is refused until it lands (said once):`,
                  e
                );
              }
              const kept = saves.get(convoKey) ?? new Set<string>();
              for (const id of ids) kept.add(id);
              saves.set(convoKey, kept);
            }
          }
        } catch (e) {
          // AN UNEXPECTED THROW LOSES NOTHING: whatever was taken and not yet written goes back.
          console.error(
            `[CATCHUP_WRITES] a flush threw (${origin}) - what it had not written is held again:`,
            e
          );
          for (const entries of byConvo.values()) reactions.unshift(...entries);
          for (const [convoKey, ids] of takenSaves) {
            const kept = saves.get(convoKey) ?? new Set<string>();
            for (const id of ids) kept.add(id);
            saves.set(convoKey, kept);
          }
        } finally {
          track(frames, -1);
          if (blockingSaid && reactions.length === 0 && saves.size === 0) {
            blockingSaid = false;
            console.info(
              '[CATCHUP_WRITES] every held write has landed - checkpoints are no longer refused'
            );
          }
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
      noteDeferredOutsideWindow('a reaction');
      reactions.push(entry);
    },
    deferConversationSave(convoKey, frameId) {
      noteDeferredOutsideWindow('a conversation save');
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
      const left = reactions.length + saves.size;
      if (left > 0) {
        // REFUSED, never handed over: a checkpoint that exported now would let the frames it covers be
        // acknowledged ahead of a write that has not landed (idsDurableEnoughToAck), and a kill
        // would lose the read mark or the reaction for good. The next hold writes them again.
        holds -= 1;
        // The cause was said where it failed, once; this says only what the checkpoint was told.
        log(`[CATCHUP_WRITES] a checkpoint is refused: ${left} held write(s) did not land`);
        throw new CatchupWritesNotStoredError(left);
      }
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
