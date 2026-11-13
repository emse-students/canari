/**
 * The composer's own undo stack for TOOLBAR actions. The editor is a contenteditable rebuilt from
 * the text, so the browser's undo never sees a toolbar rewrite: Ctrl+Z after Gras would skip it or
 * revert something older. Each action records a `(text, selection)` snapshot before and after; undo
 * and redo apply only while the current text is exactly the one the entry left, i.e. while the last
 * change WAS that toolbar action. Any other text (typing, a paste) hands the key to the browser, and
 * drops the redo side so a redo can never overwrite what was typed since.
 */

/** A text and the selection that goes with it. */
export interface FormatSnapshot {
  text: string;
  start: number;
  end: number;
}

interface HistoryEntry {
  before: FormatSnapshot;
  after: FormatSnapshot;
}

/** Entries kept per field: a toolbar session is short, and the browser keeps the typing. */
const MAX_ENTRIES = 50;

/** What a key press asks of the history: `undo`, `redo`, or `null` when it is not ours to read. */
export function historyKeyAction(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): 'undo' | 'redo' | null {
  if (e.altKey || e.ctrlKey === e.metaKey) return null;
  const key = e.key.toLowerCase();
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !e.shiftKey && e.ctrlKey) return 'redo';
  return null;
}

/** One history per field. */
export class ComposerFormatHistory {
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];

  /** Records one applied toolbar action. A new action ends the redo side. */
  record(before: FormatSnapshot, after: FormatSnapshot): void {
    this.#undo.push({ before, after });
    if (this.#undo.length > MAX_ENTRIES) this.#undo.shift();
    this.#redo = [];
  }

  /**
   * The snapshot to restore, or `null` when the browser should handle the key: `current` must be
   * the text the last entry produced. A mismatch means the member changed the text since, so the
   * redo side is dropped.
   */
  undo(current: string): FormatSnapshot | null {
    const entry = this.#undo.at(-1);
    if (!entry || entry.after.text !== current) {
      this.#redo = [];
      return null;
    }
    this.#undo.pop();
    this.#redo.push(entry);
    return entry.before;
  }

  /** The snapshot to reapply, or `null`: `current` must be the text the undone entry started from. */
  redo(current: string): FormatSnapshot | null {
    const entry = this.#redo.at(-1);
    if (!entry || entry.before.text !== current) {
      this.#redo = [];
      return null;
    }
    this.#redo.pop();
    this.#undo.push(entry);
    return entry.after;
  }
}
