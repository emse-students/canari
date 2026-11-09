import { refusalCode, refusalStatus } from '$lib/utils/apiRefusal';
import { Log } from '$lib/utils/Log';
import type { CreateFormPayload } from './api';
import { FORM_DRAFT_CONFLICT, FormDraftConflictError } from './draftConflict';

/** How long the editor waits after the last keystroke before saving: a burst of typing is one save. */
export const AUTOSAVE_DELAY_MS = 1500;

/**
 * Where the autosave stands, as the status line says it:
 * - `idle`: nothing typed since the page opened;
 * - `saving`: an edit is waiting for its save, or the save is in flight ("Enregistrement...");
 * - `saved`: the server holds everything typed ("Enregistré");
 * - `offline`: the last save reached no server; the edits wait on the device and are sent again when
 *   the link returns, at the next edit, or when the page is hidden ("Non enregistré - hors ligne");
 * - `error`: the server refused the save (not a conflict); retried at the next edit;
 * - `conflict`: another tab or device moved the revision - this page stops saving rather than
 *   overwrite it, and asks to be reloaded.
 */
export type AutosaveStatus = 'idle' | 'saving' | 'saved' | 'offline' | 'error' | 'conflict';

/**
 * Stores `document` as the revision after `baseRevision`, as the save `saveId`; resolves the new
 * revision. `leaving`: the page is being hidden or left (the request should outlive it).
 */
export type SaveRevision = (
  baseRevision: number,
  document: CreateFormPayload,
  saveId: string,
  leaving: boolean
) => Promise<{ revision: number }>;

/**
 * The device copy of what the server does not hold yet (`draftCopies.ts`), for ONE form: written at
 * every edit and at every send, deleted once the save that sends it landed. Absent, the edits live
 * in the page only.
 */
export interface AutosaveDeviceCopy {
  /**
   * `after`: the saves sent before this one that nobody answered - a revision one of them wrote is
   * this document's base, so a page closed now is re-based on it when reopened, never dropped.
   */
  keep(
    baseRevision: number,
    saveId: string,
    document: CreateFormPayload,
    after: string[]
  ): Promise<void>;
  /** The save `saveId` landed: its copy goes, unless a newer edit replaced it. */
  sent(saveId: string): Promise<void>;
  /** The revision was published or discarded: nothing of it is owed. */
  drop(): Promise<void>;
}

/** One document waiting to be sent, and the id of the save that sends it. */
interface Pending {
  document: CreateFormPayload;
  saveId: string;
}

/**
 * THE EDITOR'S AUTOSAVE (owner, 2026-11-08): every edit is saved as the form's unpublished revision
 * (`PUT /forms/:id/draft`), debounced, and at once when the page is hidden, left, or the editor is
 * torn down by an in-app navigation (no `pagehide` fires then).
 *
 * ONE SAVE IN FLIGHT, ALWAYS THE LATEST DOCUMENT: an edit made while a save runs is sent when it
 * returns, built on the revision that save produced - so two saves of one page never race each
 * other's compare-and-set. A save another writer beat is a `conflict`, and nothing is sent after it.
 *
 * A SAVE IS NAMED BY ITS CLIENT, and the name rides on the revision it writes: a save whose answer
 * was lost is found in the 409 of the next one (`FormDraftConflictError.saveId`) and ADOPTED - it
 * landed - instead of being reported as another writer's. The device copy records those unanswered
 * saves (`after`), so the adoption survives the page: reopened, or sent by the resend, a copy whose
 * predecessor wrote the revision is re-based on it.
 *
 * OFFLINE EDITS ARE KEPT ON THE DEVICE (owner, 2026-11-08): every document is written to the device
 * copy before it is sent ({@link AutosaveDeviceCopy}), so closing the tab or the app loses nothing;
 * the copy is sent again by the editor when it reopens, or by the background resend when the link
 * returns (`draftResend.ts`). `online` is a trigger to TRY, never a proof of reachability.
 */
export class FormAutosave {
  status = $state<AutosaveStatus>('idle');
  /** The revision the server holds; the base of the next save. */
  revision = $state(0);
  /** Whether a revision holds unpublished edits (a save landed since the last publish or discard). */
  hasChanges = $state(false);

  #save: SaveRevision;
  #delayMs: number;
  #device: AutosaveDeviceCopy | null;
  #newSaveId: () => string;
  #pending: Pending | null = null;
  /**
   * The sent saves nobody answered since the last answer: any may have landed, and a 409 naming one
   * says it did. Emptied by the next answer - the server's revision is known again.
   */
  #unanswered: string[] = [];
  /**
   * The save on its way and not answered yet: it may land after this page is gone, so every copy
   * kept meanwhile records it in `after` - a page closed now re-bases on it instead of dropping.
   */
  #sending: Pending | null = null;
  /**
   * Bumped by every publication or discard ({@link closed}): the answer to a save sent on a
   * revision closed since is read by nobody - it can only be a 409 on the old base, and the save's
   * document, when still owed, was carried onto the new revision.
   */
  #era = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: Promise<void> | null = null;

  constructor(opts: {
    save: SaveRevision;
    revision?: number;
    hasChanges?: boolean;
    delayMs?: number;
    device?: AutosaveDeviceCopy | null;
    newSaveId?: () => string;
  }) {
    this.#save = opts.save;
    this.revision = opts.revision ?? 0;
    this.hasChanges = opts.hasChanges ?? false;
    this.#delayMs = opts.delayMs ?? AUTOSAVE_DELAY_MS;
    this.#device = opts.device ?? null;
    this.#newSaveId = opts.newSaveId ?? (() => crypto.randomUUID());
  }

  /** An edit: kept on the device now, saved after {@link AUTOSAVE_DELAY_MS} without another one. */
  schedule(document: CreateFormPayload): void {
    if (this.status === 'conflict') return;
    this.#pending = { document, saveId: this.#newSaveId() };
    this.#keep(this.#pending);
    this.status = 'saving';
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#delayMs);
  }

  /**
   * Resumes a save a closed page left on the device - the SAME save, its id kept, so a copy that had
   * in fact landed is recognised by the server's answer - and sends it at once.
   */
  resume(document: CreateFormPayload, saveId: string, after: string[] = []): void {
    if (this.status === 'conflict') return;
    Log.d('forms-autosave', `resuming the device copy built on revision ${this.revision}`);
    this.#unanswered = [...after];
    this.#pending = { document, saveId };
    this.status = 'saving';
    void this.flush();
  }

  /**
   * Saves what is pending NOW (the page is hidden, left, torn down, or about to publish).
   * `leaving`: the page may not live to read the answer - the request is asked to outlive it.
   */
  async flush(opts: { leaving?: boolean } = {}): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    // One save at a time: an edit made meanwhile is sent when the running one returns.
    while (this.#inFlight) await this.#inFlight;
    if (!this.#pending || this.status === 'conflict') return;
    const pending = this.#pending;
    this.#pending = null;
    this.status = 'saving';
    this.#inFlight = this.#send(pending, opts.leaving === true);
    try {
      await this.#inFlight;
    } finally {
      this.#inFlight = null;
    }
    if (this.#pending && this.status === 'saving') await this.flush(opts);
  }

  /** Whether everything typed is on the server (nothing pending, nothing in flight, no failure). */
  get settled(): boolean {
    return !this.#pending && !this.#inFlight && !this.#timer && this.status !== 'offline';
  }

  /**
   * A publication or a discard emptied the revision: the editor now builds on `revision`.
   *
   * An edit typed WHILE a publication ran is not part of what it published (the page saved
   * everything first and published that), and it is KEPT: it becomes the first save of the next
   * revision - "Modifications non publiées" again - rather than vanish. Blocking the inputs instead
   * would freeze a manager mid-word for a request's length, and a keystroke dropped in silence is a
   * loss nobody sees. A DISCARD drops it: the manager asked for the edits to go, and the page shows
   * the published form again.
   */
  closed(revision: number, how: 'published' | 'discarded'): void {
    this.revision = revision;
    this.hasChanges = false;
    this.#unanswered = [];
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    // A save whose timer fired DURING the publication is on its way on the old base: it will be
    // refused, and its answer is ignored (`#era`). Its document is owed all the same - it is the
    // edit typed meanwhile when nothing newer is pending.
    const onItsWay = this.#sending;
    this.#sending = null;
    this.#era += 1;
    const typedMeanwhile = how === 'published' ? (this.#pending ?? onItsWay) : null;
    this.#pending = null;
    if (typedMeanwhile) {
      this.#pending = typedMeanwhile;
      Log.d(
        'forms-autosave',
        `an edit typed during the publication kept: saved on revision ${revision}`
      );
      this.#keep(typedMeanwhile);
      this.status = 'saving';
      void this.flush();
      return;
    }
    this.status = 'saved';
    this.#dropCopy('the revision was published or discarded');
  }

  /**
   * Wires the page's own triggers: hidden or left saves at once (asked to outlive the page), the
   * browser's `online` retries an edit that reached no server. Returns the cleanup, which SAVES what
   * is pending: an in-app navigation tears the editor down with no `pagehide`, and the save runs on
   * after the page is gone.
   */
  attach(win: Window = window): () => void {
    const onHidden = () => {
      if (win.document.visibilityState === 'hidden') void this.flush({ leaving: true });
    };
    const onLeave = () => void this.flush({ leaving: true });
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
      if (this.#pending)
        Log.d('forms-autosave', 'editor torn down with an edit pending: saved now');
      void this.flush();
    };
  }

  #keep(pending: Pending): void {
    const after = [
      ...this.#unanswered,
      ...(this.#sending && !this.#unanswered.includes(this.#sending.saveId)
        ? [this.#sending.saveId]
        : []),
    ].filter((id) => id !== pending.saveId);
    this.#device
      ?.keep(this.revision, pending.saveId, pending.document, after)
      .catch((e: unknown) =>
        console.warn(
          `[forms-autosave] device copy not written - the edit lives in this page only: ${e}`
        )
      );
  }

  #dropCopy(why: string): void {
    this.#device
      ?.drop()
      .catch((e: unknown) =>
        console.warn(`[forms-autosave] device copy not dropped (${why}): ${e}`)
      );
  }

  /** The save `saveId` landed as `revision`: it is the base now, and its device copy goes. */
  #landed(saveId: string, revision: number): void {
    this.revision = revision;
    this.hasChanges = true;
    // An answer: the server's revision is known, and no earlier unanswered save can land after it
    // (its base is behind).
    this.#unanswered = [];
    this.#device
      ?.sent(saveId)
      .catch((e: unknown) => console.warn(`[forms-autosave] device copy not cleared: ${e}`));
    // An edit typed meanwhile is built on the new revision: its copy says so, or a page closed
    // before it is sent would leave a copy on a base the server has moved past.
    if (this.#pending) this.#keep(this.#pending);
  }

  /** The answer to a save sent on a revision {@link closed} since: logged, and nothing else. */
  #staleAnswer(pending: Pending, what: string): void {
    Log.d(
      'forms-autosave',
      `answer to save ${pending.saveId.slice(0, 8)} on a closed revision ignored (${what}): its document was carried over`
    );
  }

  async #send(pending: Pending, leaving: boolean): Promise<void> {
    // Written before it leaves, on the base it is sent on.
    this.#keep(pending);
    this.#sending = pending;
    const era = this.#era;
    try {
      const saved = await this.#save(this.revision, pending.document, pending.saveId, leaving);
      if (era !== this.#era) return this.#staleAnswer(pending, 'saved');
      this.#sending = null;
      this.#landed(pending.saveId, saved.revision);
      // An edit typed during the save keeps the line on "Enregistrement..." until it lands too.
      this.status = this.#pending ? 'saving' : 'saved';
      Log.d('forms-autosave', `revision ${saved.revision} saved`);
    } catch (e) {
      if (era !== this.#era) return this.#staleAnswer(pending, String(e));
      // Answered or not, it is on its way no more: an unanswered one moves to `#unanswered` below.
      this.#sending = null;
      if (e instanceof FormDraftConflictError && e.saveId !== null) {
        if (e.saveId === pending.saveId) {
          // This very save landed already (sent again after a lost answer, or by the resend).
          Log.d('forms-autosave', `save already landed as revision ${e.revision}: adopted`);
          this.#landed(pending.saveId, e.revision);
          this.status = this.#pending ? 'saving' : 'saved';
          return;
        }
        if (this.#unanswered.includes(e.saveId)) {
          // A save before it landed and its answer was lost: build on it, send this one again.
          Log.d('forms-autosave', `an unanswered save landed as revision ${e.revision}: adopted`);
          this.#pending = this.#pending ?? pending;
          this.#landed(e.saveId, e.revision);
          this.status = 'saving';
          return;
        }
      }
      if (refusalCode(e) === FORM_DRAFT_CONFLICT) {
        // The device copy is KEPT: the edits are still on screen, and a reopened editor or the
        // resend tells the member when it finds them unsendable.
        console.warn(
          `[forms-autosave] revision ${this.revision} moved elsewhere: autosave stopped, device copy kept`
        );
        this.status = 'conflict';
        this.#pending = null;
        return;
      }
      // Kept to send again: the newest edit wins, an older one is never sent after it.
      this.#pending = this.#pending ?? pending;
      if (refusalStatus(e) === null) {
        // Nobody answered: it may have landed, and the next save's 409 will say so. The copy of
        // what is pending records it, so a page closed before that 409 still knows.
        if (!this.#unanswered.includes(pending.saveId)) this.#unanswered.push(pending.saveId);
        if (this.#pending !== pending) this.#keep(this.#pending);
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
