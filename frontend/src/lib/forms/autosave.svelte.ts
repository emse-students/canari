import { refusalCode, refusalStatus } from '$lib/utils/apiRefusal';
import { Log } from '$lib/utils/Log';
import type { CreateFormPayload } from './api';

/** The 409 of a save built on a revision another tab, a publication or a discard moved. */
export const FORM_DRAFT_CONFLICT = 'FORM_DRAFT_CONFLICT';

/** How long the editor waits after the last keystroke before saving: a burst of typing is one save. */
export const AUTOSAVE_DELAY_MS = 1500;

/**
 * Where the autosave stands, as the status line says it:
 * - `idle`: nothing typed since the page opened;
 * - `saving`: an edit is waiting for its save, or the save is in flight ("Enregistrement...");
 * - `saved`: the server holds everything typed ("Enregistré");
 * - `offline`: the last save reached no server; the edits wait in this page and are sent again when
 *   the link returns, at the next edit, or when the page is hidden ("Non enregistré - hors ligne");
 * - `error`: the server refused the save (not a conflict); retried at the next edit;
 * - `conflict`: another tab or device moved the revision - this page stops saving rather than
 *   overwrite it, and asks to be reloaded.
 */
export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'offline' | 'error' | 'conflict';

/** Stores `document` as the revision after `baseRevision`; resolves the new revision. */
export type SaveRevision = (
  baseRevision: number,
  document: CreateFormPayload
) => Promise<{ revision: number }>;

/**
 * THE EDITOR'S AUTOSAVE (owner, 2026-11-08): every edit is saved as the form's unpublished revision
 * (`PUT /forms/:id/draft`), debounced, and at once when the page is hidden or left.
 *
 * ONE SAVE IN FLIGHT, ALWAYS THE LATEST DOCUMENT: an edit made while a save runs is sent when it
 * returns, built on the revision that save produced - so two saves of one page never race each
 * other's compare-and-set. A save another writer beat is a `conflict`, and nothing is sent after it.
 *
 * OFFLINE EDITS ARE KEPT IN THIS PAGE ONLY (decided 2026-11-08): they are retried when the browser
 * says the link returned (`online` - a trigger to TRY, never a proof of reachability), at the next
 * edit and when the page is hidden. Closing the page while offline loses them, and the status line
 * says "Non enregistré - hors ligne" until then; nothing is written to device storage, which would
 * outlive the session and the account that typed it.
 */
export class FormAutosave {
  status = $state<AutosaveStatus>('idle');
  /** The revision the server holds; the base of the next save. */
  revision = $state(0);
  /** Whether a revision holds unpublished edits (a save landed since the last publish or discard). */
  hasChanges = $state(false);

  #save: SaveRevision;
  #delayMs: number;
  #pending: CreateFormPayload | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: Promise<void> | null = null;

  constructor(opts: {
    save: SaveRevision;
    revision?: number;
    hasChanges?: boolean;
    delayMs?: number;
  }) {
    this.#save = opts.save;
    this.revision = opts.revision ?? 0;
    this.hasChanges = opts.hasChanges ?? false;
    this.#delayMs = opts.delayMs ?? AUTOSAVE_DELAY_MS;
  }

  /** An edit: saved after {@link AUTOSAVE_DELAY_MS} without another one. */
  schedule(document: CreateFormPayload): void {
    if (this.status === 'conflict') return;
    this.#pending = document;
    this.status = 'saving';
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#delayMs);
  }

  /** Saves what is pending NOW (the page is hidden, left, or about to publish). */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    // One save at a time: an edit made meanwhile is sent when the running one returns.
    while (this.#inFlight) await this.#inFlight;
    if (!this.#pending || this.status === 'conflict') return;
    const document = this.#pending;
    this.#pending = null;
    this.status = 'saving';
    this.#inFlight = this.#send(document);
    try {
      await this.#inFlight;
    } finally {
      this.#inFlight = null;
    }
    if (this.#pending && this.status === 'saving') await this.flush();
  }

  /** Whether everything typed is on the server (nothing pending, nothing in flight, no failure). */
  get settled(): boolean {
    return !this.#pending && !this.#inFlight && !this.#timer && this.status !== 'offline';
  }

  /** A publication or a discard emptied the revision: the editor now builds on `revision`. */
  closed(revision: number): void {
    this.revision = revision;
    this.hasChanges = false;
    this.#pending = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.status = 'saved';
  }

  /**
   * Wires the page's own triggers: hidden or left saves at once, and the browser's `online` retries
   * an edit that reached no server. Returns the cleanup.
   */
  attach(win: Window = window): () => void {
    const onHidden = () => {
      if (win.document.visibilityState === 'hidden') void this.flush();
    };
    const onLeave = () => void this.flush();
    const onOnline = () => {
      if (this.status === 'offline') void this.flush();
    };
    win.document.addEventListener('visibilitychange', onHidden);
    win.addEventListener('pagehide', onLeave);
    win.addEventListener('online', onOnline);
    return () => {
      win.document.removeEventListener('visibilitychange', onHidden);
      win.removeEventListener('pagehide', onLeave);
      win.removeEventListener('online', onOnline);
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
    };
  }

  async #send(document: CreateFormPayload): Promise<void> {
    try {
      const saved = await this.#save(this.revision, document);
      this.revision = saved.revision;
      this.hasChanges = true;
      // An edit typed during the save keeps the line on "Enregistrement..." until it lands too.
      this.status = this.#pending ? 'saving' : 'saved';
      Log.d('forms-autosave', `revision ${saved.revision} saved`);
    } catch (e) {
      if (refusalCode(e) === FORM_DRAFT_CONFLICT) {
        console.warn(
          `[forms-autosave] revision ${this.revision} moved elsewhere: autosave stopped`
        );
        this.status = 'conflict';
        return;
      }
      // Kept to send again: the newest edit wins, an older one is never sent after it.
      this.#pending = this.#pending ?? document;
      if (refusalStatus(e) === null) {
        console.warn(
          `[forms-autosave] save reached no server, kept for the next try: ${String(e)}`
        );
        this.status = 'offline';
      } else {
        console.warn(
          `[forms-autosave] save refused status=${refusalStatus(e)} code=${refusalCode(e)}`
        );
        this.status = 'error';
      }
    }
  }
}
