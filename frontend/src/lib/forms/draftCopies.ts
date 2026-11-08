/**
 * THE DEVICE COPY OF A FORM'S UNSENT EDITS (owner, 2026-11-08): what the editor typed and the server
 * does not hold yet lives HERE until a save lands, so closing the tab or the app, a lost network or a
 * keepalive that did not fit loses nothing - `docs/wiki/frontend/modules/forms.md`.
 *
 * ONE DATABASE PER ACCOUNT, `CanariDBFormDrafts_<userId>`, deleted with the account
 * (`accountIndexedDbNames`) and at sign-out (`eraseFormDraftCopies`, from `clearAuthUnderway`): the
 * next account on this device never sees, nor sends, another account's edits. The connection CLOSES
 * ITSELF on `versionchange`, the event a `deleteDatabase` raises, so neither erase blocks on it.
 *
 * ONE RECORD PER FORM, keyed by the form's id - minted by the client on the create page, so a form
 * the server has never seen has its key too (`created: false`). A record names the revision its
 * document is built on and the client id of the save that sends it: whoever sends it - the editor,
 * or {@link resendFormDraftCopies} after a restart - sends the SAME save, and the server's answer
 * (`saveId` in its 409) tells a landed save from another writer's.
 *
 * NOT SEALED BY THE DEVICE KEY, deliberately: a form's content is no secret of its editor's (its
 * respondents read it), the publish queue keeps posts the same way, and the record dies with the
 * session.
 */
import type { CreateFormPayload } from './api';
import { idbCommitted, idbRequest } from '$lib/db/outboxBlob';
import { deleteIndexedDbByName } from '$lib/utils/indexedDbDelete';
import { appendLog } from '$lib/utils/sessionLog';
import { Log } from '$lib/utils/Log';

const DB_PREFIX = 'CanariDBFormDrafts_';
const DB_VERSION = 1;
const COPIES = 'copies';

/** The device copies' database for `userId` - also what the account wipe deletes. */
export function formDraftCopiesDbName(userId: string): string {
  return DB_PREFIX + userId;
}

/** One form's edits that no save has landed yet. */
export interface FormDraftCopy {
  formId: string;
  /** The revision the document is built on: the base of the save that sends it. */
  baseRevision: number;
  /** The client id of the save that sends this document - one per document, minted when typed. */
  saveId: string;
  document: CreateFormPayload;
  /** Whether the server holds the form; `false` for a create page's draft not created yet. */
  created: boolean;
}

/** The device copies of one account. */
export class FormDraftCopyStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(readonly userId: string) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(formDraftCopiesDbName(this.userId), DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(COPIES)) {
          req.result.createObjectStore(COPIES, { keyPath: 'formId' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // A `deleteDatabase` (sign-out, the account wipe) asks every connection to go: this one
        // does, so the delete completes instead of blocking on it.
        db.onversionchange = () => {
          appendLog('[FORM-DRAFT-COPY] store closed: the database is being deleted');
          db.close();
          this.db = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        this.db = null;
        reject(req.error);
      };
    });
    return this.db;
  }

  /** Writes the copy of `copy.formId`, replacing the one it held. */
  async put(copy: FormDraftCopy): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(COPIES, 'readwrite');
    const done = idbCommitted(tx);
    tx.objectStore(COPIES).put(copy);
    await done;
  }

  /** The copy of `formId`, or `null` when every edit of it reached the server. */
  async get(formId: string): Promise<FormDraftCopy | null> {
    const db = await this.open();
    const row = await idbRequest(
      db.transaction(COPIES, 'readonly').objectStore(COPIES).get(formId)
    );
    return (row as FormDraftCopy | undefined) ?? null;
  }

  /** Every copy this account holds. */
  async list(): Promise<FormDraftCopy[]> {
    const db = await this.open();
    return (await idbRequest(
      db.transaction(COPIES, 'readonly').objectStore(COPIES).getAll()
    )) as FormDraftCopy[];
  }

  /**
   * Deletes the copy of `formId` when it is still the one save `saveId` sent - read and deleted in
   * ONE transaction, so the answer to an older save never deletes an edit typed after it.
   *
   * @returns whether a copy was deleted.
   */
  async deleteIfSent(formId: string, saveId: string): Promise<boolean> {
    const db = await this.open();
    const tx = db.transaction(COPIES, 'readwrite');
    const done = idbCommitted(tx);
    const copies = tx.objectStore(COPIES);
    let deleted = false;
    const read = copies.get(formId);
    read.onsuccess = () => {
      const copy = read.result as FormDraftCopy | undefined;
      if (copy?.saveId !== saveId) return;
      copies.delete(formId);
      deleted = true;
    };
    await done;
    return deleted;
  }

  /** Deletes the copy of `formId`, whatever save it names (another writer superseded it). */
  async delete(formId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(COPIES, 'readwrite');
    const done = idbCommitted(tx);
    tx.objectStore(COPIES).delete(formId);
    await done;
  }
}

let cached: FormDraftCopyStore | null = null;

/** The store of `userId`, one per realm and account. */
export function formDraftCopyStore(userId: string): FormDraftCopyStore {
  if (cached?.userId !== userId) cached = new FormDraftCopyStore(userId);
  return cached;
}

/**
 * Deletes every device copy of `userId` (sign-out): the next account on this device never sees nor
 * sends them. Never rejects; a failure is logged with the account's prefix.
 */
export async function eraseFormDraftCopies(userId: string | null, why: string): Promise<void> {
  if (!userId) return;
  if (cached?.userId === userId) cached = null;
  const deleted = await deleteIndexedDbByName(formDraftCopiesDbName(userId), 'FORM-DRAFT-COPY');
  Log.d('FORM-DRAFT-COPY', `copies of ${userId.slice(0, 8)} erased (${why}): ${deleted}`);
}

// ── One sender per form: the editor, or the background resend - never both ───────────────────────

/** The forms an editor of THIS realm holds open. */
const openHere = new Map<string, number>();

/** The Web Locks API, or `null` where the engine has none (one realm then - `deviceKeyGate.ts`). */
function webLocks(): LockManager | null {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks && typeof locks.request === 'function' ? locks : null;
}

const lockName = (formId: string) => `canari-form-editor-${formId}`;

/**
 * Marks `formId` as open in an editor until the returned release is called: the background resend
 * leaves its copy to that editor, in this tab ({@link openHere}) and in every other one (a SHARED
 * Web Lock - two editors of one form may be open, and their compare-and-set settles them).
 */
export function holdFormEditor(formId: string): () => void {
  openHere.set(formId, (openHere.get(formId) ?? 0) + 1);
  let release: (() => void) | null = null;
  const locks = webLocks();
  if (locks) {
    const held = new Promise<void>((r) => (release = r));
    void locks
      .request(lockName(formId), { mode: 'shared' }, () => held)
      .catch((e: unknown) =>
        console.warn(`[FORM-DRAFT-COPY] editor lock of ${formId} failed: ${e}`)
      );
  }
  return () => {
    const n = (openHere.get(formId) ?? 1) - 1;
    if (n > 0) openHere.set(formId, n);
    else openHere.delete(formId);
    release?.();
  };
}

/** Runs `fn` while no editor of any tab holds `formId` open; resolves `false` when one does. */
async function whenNoEditor(formId: string, fn: () => Promise<void>): Promise<boolean> {
  if (openHere.has(formId)) return false;
  const locks = webLocks();
  if (!locks) {
    await fn();
    return true;
  }
  return locks.request(lockName(formId), { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await fn();
    return true;
  });
}

// ── The background resend: copies left by a closed page reach the server when it answers ─────────

/** What a resend needs from the forms API (injected by the tests). */
export interface ResendDeps {
  store: Pick<FormDraftCopyStore, 'list' | 'put' | 'deleteIfSent' | 'delete'>;
  /** Whether this estate stores revisions (`formDrafts`); a copy waits while it does not say so. */
  formDrafts: () => boolean;
  createDraft: (copy: FormDraftCopy) => Promise<unknown>;
  save: (copy: FormDraftCopy) => Promise<unknown>;
  /** The refusal's status, `null` when nobody answered. */
  statusOf: (e: unknown) => number | null;
  /** The client id of the save a conflict names, `undefined` when the error is no conflict. */
  conflictSaveId: (e: unknown) => string | null | undefined;
}

/**
 * Sends every device copy no editor holds open: creates the form first when the server never saw it
 * (the create is idempotent on its id), then saves the copy as the save it already is. A copy is
 * deleted once its save landed - answered, or named by the server's 409 - and dropped, LOGGED, when
 * the server refused it for good (another writer's revision, a form gone or no longer this
 * account's). One that reached no server, or a 5xx, stays for the next pass; the pass stops there,
 * as the next copy would meet the same link.
 */
export async function resendFormDraftCopies(deps: ResendDeps): Promise<void> {
  if (!deps.formDrafts()) {
    Log.d('FORM-DRAFT-COPY', 'resend skipped: this estate does not say it stores revisions');
    return;
  }
  const copies = await deps.store.list();
  for (const copy of copies) {
    let reachedNoServer = false;
    await whenNoEditor(copy.formId, async () => {
      try {
        if (!copy.created) {
          await deps.createDraft(copy);
          copy.created = true;
          await deps.store.put(copy);
        }
        await deps.save(copy);
        await deps.store.deleteIfSent(copy.formId, copy.saveId);
        Log.d('FORM-DRAFT-COPY', `copy of ${copy.formId} sent`);
      } catch (e) {
        const conflictOf = deps.conflictSaveId(e);
        if (conflictOf === copy.saveId) {
          await deps.store.deleteIfSent(copy.formId, copy.saveId);
          Log.d('FORM-DRAFT-COPY', `copy of ${copy.formId} had landed; its answer was lost`);
          return;
        }
        const status = deps.statusOf(e);
        if (status === null || status >= 500) {
          console.warn(
            `[FORM-DRAFT-COPY] copy of ${copy.formId} kept for the next try: ${status ?? 'no answer'}`
          );
          reachedNoServer = true;
          return;
        }
        console.warn(
          `[FORM-DRAFT-COPY] copy of ${copy.formId} (base ${copy.baseRevision}) DROPPED: refused ${status}${conflictOf !== undefined ? ', another writer moved the revision' : ''}`
        );
        await deps.store.delete(copy.formId);
      }
    });
    if (reachedNoServer) return;
  }
}

/**
 * The autosave's device copy of form `formId` for `userId`. `created`: whether the server holds the
 * form yet (a create page's draft is kept before its shell exists, and the resend creates it).
 */
export function deviceCopyOf(
  userId: string,
  formId: string,
  created: () => boolean
): {
  keep(baseRevision: number, saveId: string, document: CreateFormPayload): Promise<void>;
  sent(saveId: string): Promise<void>;
  drop(): Promise<void>;
} {
  const store = formDraftCopyStore(userId);
  return {
    keep: (baseRevision, saveId, document) =>
      store.put({ formId, baseRevision, saveId, document, created: created() }),
    sent: async (saveId) => {
      await store.deleteIfSent(formId, saveId);
    },
    drop: () => store.delete(formId),
  };
}
