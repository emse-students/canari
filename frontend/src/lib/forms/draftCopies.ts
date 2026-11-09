/**
 * THE DEVICE COPY OF A FORM'S UNSENT EDITS (owner, 2026-11-08): what the editor typed and the server
 * does not hold yet lives HERE until a save lands, so closing the tab or the app, a lost network or a
 * keepalive that did not fit loses nothing - `docs/wiki/frontend/modules/forms.md`.
 *
 * ONE DATABASE PER ACCOUNT, `CanariDBFormDrafts_<userId>`, deleted with the account
 * (`accountIndexedDbNames`) and at sign-out (`eraseFormDraftCopies`, from `clearAuthUnderway`): the
 * next account on this device never sees, nor sends, another account's edits. The connection CLOSES
 * ITSELF on `versionchange`, the event a `deleteDatabase` raises, so neither erase blocks on it. And
 * the store REFUSES every operation once its account is no longer the one signed in
 * ({@link FormDraftCopyAccountGoneError}): a store captured before the sign-out - an editor torn
 * down on its way to `/login`, a resend pass in flight - can neither recreate the erased database nor
 * read it into another account's session.
 *
 * ONE RECORD PER FORM, keyed by the form's id once the server holds it, and by the create's
 * idempotency key (`clientCreateId`, minted by the create page) before: a record with no `formId` is
 * a form the server never answered, and whoever sends it creates it first - the SAME create - then
 * re-keys it ({@link FormDraftCopyStore.rekey}). A record names the revision its document is built
 * on, the client id of the save that sends it, and the sent saves nobody answered before it
 * (`after`): whoever sends it - the editor, or {@link resendFormDraftCopies} after a restart - sends
 * the SAME save, and the server's answer (`saveId` in its 409) tells a landed save, or a landed
 * predecessor, from another writer's.
 *
 * NOT SEALED BY THE DEVICE KEY, deliberately: a form's content is no secret of its editor's (its
 * respondents read it), the publish queue keeps posts the same way, and the record dies with the
 * session.
 */
import type { CreateFormPayload } from './api';
import { idbCommitted, idbRequest } from '$lib/db/outboxBlob';
import { currentUserId } from '$lib/stores/userState.svelte';
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
  /** The record's key: `formId` once the server holds the form, `clientCreateId` before. */
  key: string;
  /** The form's id, `null` while no create of it was answered. */
  formId: string | null;
  /** The create's idempotency key, for a form made on the create page; `null` otherwise. */
  clientCreateId: string | null;
  /** The revision the document is built on: the base of the save that sends it. */
  baseRevision: number;
  /** The client id of the save that sends this document - one per document, minted when typed. */
  saveId: string;
  /**
   * The saves sent before this one that nobody answered: any of them may have landed, and a
   * revision written by one of them is THIS document's base, not another writer's.
   */
  after: string[];
  document: CreateFormPayload;
}

/**
 * Refused: the store's account is no longer the one signed in (signed out, or another account
 * signed in since). Its database is erased or about to be, and nothing may recreate or read it.
 */
export class FormDraftCopyAccountGoneError extends Error {
  constructor(userId: string) {
    super(`the device copies of ${userId.slice(0, 8)} belong to an account no longer signed in`);
    this.name = 'FormDraftCopyAccountGoneError';
  }
}

/** The device copies of one account. */
export class FormDraftCopyStore {
  private db: Promise<IDBDatabase> | null = null;

  /**
   * @param signedIn whether `userId` is the account signed in NOW - read before opening the
   *   database and before every transaction (the tests inject it).
   */
  constructor(
    readonly userId: string,
    private readonly signedIn: () => boolean = () => currentUserId() === userId
  ) {}

  /** Throws when the account is gone; the open connection, if any, is closed with it. */
  private guard(): void {
    if (this.signedIn()) return;
    const db = this.db;
    this.db = null;
    void db?.then((d) => d.close()).catch(() => undefined);
    throw new FormDraftCopyAccountGoneError(this.userId);
  }

  private async open(): Promise<IDBDatabase> {
    // Never `indexedDB.open` for a signed-out account: it would recreate the erased database.
    this.guard();
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(formDraftCopiesDbName(this.userId), DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(COPIES)) {
          req.result.createObjectStore(COPIES, { keyPath: 'key' });
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
    const db = await this.db;
    // The sign-out may have come while the database opened.
    this.guard();
    return db;
  }

  /** Writes `copy`, replacing the one its key held (and the one its create key held, once created). */
  async put(copy: FormDraftCopy): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(COPIES, 'readwrite');
    const done = idbCommitted(tx);
    const copies = tx.objectStore(COPIES);
    copies.put(copy);
    if (copy.clientCreateId && copy.key !== copy.clientCreateId) copies.delete(copy.clientCreateId);
    await done;
  }

  /** The copy keyed `key`, or `null` when every edit of it reached the server. */
  async get(key: string): Promise<FormDraftCopy | null> {
    const db = await this.open();
    const row = await idbRequest(db.transaction(COPIES, 'readonly').objectStore(COPIES).get(key));
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
   * The create keyed `clientCreateId` was answered `formId`: its copy is keyed by the form from now
   * on, in ONE transaction. Absent (already sent), nothing is written.
   */
  async rekey(clientCreateId: string, formId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(COPIES, 'readwrite');
    const done = idbCommitted(tx);
    const copies = tx.objectStore(COPIES);
    const read = copies.get(clientCreateId);
    read.onsuccess = () => {
      const copy = read.result as FormDraftCopy | undefined;
      if (!copy) return;
      copies.put({ ...copy, key: formId, formId });
      copies.delete(clientCreateId);
    };
    await done;
  }

  /**
   * Deletes the copy under any of `keys` that is still the one save `saveId` sent - read and deleted
   * in ONE transaction, so the answer to an older save never deletes an edit typed after it.
   *
   * @returns whether a copy was deleted.
   */
  async deleteIfSent(keys: string[], saveId: string): Promise<boolean> {
    const db = await this.open();
    const tx = db.transaction(COPIES, 'readwrite');
    const done = idbCommitted(tx);
    const copies = tx.objectStore(COPIES);
    let deleted = false;
    for (const key of keys) {
      const read = copies.get(key);
      read.onsuccess = () => {
        const copy = read.result as FormDraftCopy | undefined;
        if (copy?.saveId !== saveId) return;
        copies.delete(key);
        deleted = true;
      };
    }
    await done;
    return deleted;
  }

  /** Deletes the copies under `keys`, whatever save they name (published, discarded, refused). */
  async delete(keys: string[]): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(COPIES, 'readwrite');
    const done = idbCommitted(tx);
    for (const key of keys) tx.objectStore(COPIES).delete(key);
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
 * sends them. Never rejects; a failure is logged with the account's prefix. A store captured earlier
 * cannot recreate the database afterwards: it refuses once `userId` is not the account signed in.
 */
export async function eraseFormDraftCopies(userId: string | null, why: string): Promise<void> {
  if (!userId) return;
  if (cached?.userId === userId) cached = null;
  // A realm with no IndexedDB (a server render, a node test) never stored a copy: nothing to erase.
  if (typeof indexedDB === 'undefined') {
    Log.d('FORM-DRAFT-COPY', `copies of ${userId.slice(0, 8)}: no IndexedDB here, none stored`);
    return;
  }
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

const lockName = (key: string) => `canari-form-editor-${key}`;

/**
 * Marks `key` (a form's id, or a create page's create key) as open in an editor until the returned
 * release is called: the background resend leaves its copy to that editor, in this tab
 * ({@link openHere}) and in every other one (a SHARED Web Lock - two editors of one form may be
 * open, and their compare-and-set settles them).
 */
export function holdFormEditor(key: string): () => void {
  openHere.set(key, (openHere.get(key) ?? 0) + 1);
  let release: (() => void) | null = null;
  const locks = webLocks();
  if (locks) {
    const held = new Promise<void>((r) => (release = r));
    void locks
      .request(lockName(key), { mode: 'shared' }, () => held)
      .catch((e: unknown) => console.warn(`[FORM-DRAFT-COPY] editor lock of ${key} failed: ${e}`));
  }
  return () => {
    const n = (openHere.get(key) ?? 1) - 1;
    if (n > 0) openHere.set(key, n);
    else openHere.delete(key);
    release?.();
  };
}

/** Runs `fn` while no editor of any tab holds `key` open; resolves `null` when one does. */
async function whenNoEditor<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  if (openHere.has(key)) return null;
  const locks = webLocks();
  if (!locks) return fn();
  return locks.request(lockName(key), { mode: 'exclusive', ifAvailable: true }, async (lock) =>
    lock ? fn() : null
  );
}

// ── The background resend: copies left by a closed page reach the server when it answers ─────────

/**
 * A conflict's facts: the revision the server holds, the client id of the save that wrote it, and
 * the saves before it (its bounded ancestry, `recentSaveIds`).
 */
export interface CopyConflict {
  revision: number;
  saveId: string | null;
  recentSaveIds?: string[];
}

/** What a resend needs from the forms API and the session (injected by the tests). */
export interface ResendDeps {
  store: Pick<FormDraftCopyStore, 'list' | 'put' | 'rekey' | 'deleteIfSent' | 'delete'>;
  /** Whether this estate stores revisions (`formDrafts`); a copy waits while it does not say so. */
  formDrafts: () => boolean;
  /**
   * Whether the copies' account is still the one signed in: read before EVERY request and every
   * write, and the pass ends at the first no - a copy is never sent under another account's token.
   */
  signedIn: () => boolean;
  /** Creates the form of a copy no create was answered for (idempotent on its create key). */
  createDraft: (copy: FormDraftCopy) => Promise<{ id: string }>;
  save: (copy: FormDraftCopy & { formId: string }) => Promise<unknown>;
  /** The refusal's status, `null` when nobody answered. */
  statusOf: (e: unknown) => number | null;
  /** The facts of a revision conflict, `undefined` when the error is no conflict. */
  conflictOf: (e: unknown) => CopyConflict | undefined;
  /** Tells the member a copy was refused for good: its edits are lost, and they must know. */
  dropped: (copy: FormDraftCopy) => void;
}

/** The pass ended: the account signed out or changed under it. */
class ResendAborted extends Error {}

/** What sending one copy came to. */
type Sent = 'done' | 'kept' | { created: FormDraftCopy };

/**
 * Sends every device copy no editor holds open: creates the form first when the server never
 * answered a create of it (the create is idempotent on its key), then saves the copy as the save it
 * already is. A copy is deleted once its save landed - answered, or named by the server's 409. One
 * whose base a predecessor it records (`after`) moved is re-based on that revision and sent. One the
 * server refused for good (another writer's revision, a form gone or no longer this account's) is
 * dropped, LOGGED, and the member TOLD ({@link ResendDeps.dropped}). One that reached no server, or
 * a 5xx, stays for the next pass; the pass stops there, as the next copy would meet the same link.
 * The pass also stops the moment the account is no longer the one signed in.
 */
export async function resendFormDraftCopies(deps: ResendDeps): Promise<void> {
  if (!deps.formDrafts()) {
    Log.d('FORM-DRAFT-COPY', 'resend skipped: this estate does not say it stores revisions');
    return;
  }
  try {
    live(deps);
    const copies = await deps.store.list();
    for (const listed of copies) {
      live(deps);
      let outcome = await whenNoEditor(listed.key, () => sendCopy(listed, deps));
      // Created: the form's own key is the one an editor of it holds.
      if (outcome !== null && typeof outcome === 'object') {
        const created = outcome.created;
        outcome = await whenNoEditor(created.key, () => sendCopy(created, deps));
      }
      if (outcome === 'kept') return;
    }
  } catch (e) {
    if (!(e instanceof ResendAborted)) throw e;
    Log.d('FORM-DRAFT-COPY', 'resend pass ended: the account is no longer signed in');
  }
}

/** Throws {@link ResendAborted} when the copies' account is no longer the one signed in. */
function live(deps: ResendDeps): void {
  if (!deps.signedIn()) throw new ResendAborted();
}

/** Sends one copy; see {@link resendFormDraftCopies}. */
async function sendCopy(start: FormDraftCopy, deps: ResendDeps): Promise<Sent> {
  let copy = start;
  try {
    if (!copy.formId) {
      live(deps);
      const created = await deps.createDraft(copy);
      live(deps);
      await deps.store.rekey(copy.key, created.id);
      Log.d('FORM-DRAFT-COPY', `copy ${copy.key} created as form ${created.id}`);
      return { created: { ...copy, key: created.id, formId: created.id } };
    }
    const formId = copy.formId;
    // At most two sends: a re-base empties `after`, so a second conflict cannot re-base again.
    for (;;) {
      try {
        live(deps);
        await deps.save({ ...copy, formId });
        live(deps);
        await deps.store.deleteIfSent([copy.key], copy.saveId);
        Log.d('FORM-DRAFT-COPY', `copy of ${formId} sent`);
        return 'done';
      } catch (e) {
        const conflict = deps.conflictOf(e);
        if (!conflict) throw e;
        if (conflict.saveId === copy.saveId || conflict.recentSaveIds?.includes(copy.saveId)) {
          // Its save landed - its answer was lost - and whatever was built on it since holds it:
          // nothing of the copy is lost, so the member is told nothing.
          live(deps);
          await deps.store.deleteIfSent([copy.key], copy.saveId);
          Log.d('FORM-DRAFT-COPY', `copy of ${formId} had landed; its answer was lost`);
          return 'done';
        }
        if (!conflict.saveId || !copy.after.includes(conflict.saveId)) throw e;
        // A save this page sent before it landed unanswered: the copy is built on it.
        Log.d(
          'FORM-DRAFT-COPY',
          `copy of ${formId} re-based on revision ${conflict.revision}, written by its predecessor`
        );
        copy = { ...copy, baseRevision: conflict.revision, after: [] };
        live(deps);
        await deps.store.put(copy);
      }
    }
  } catch (e) {
    if (e instanceof ResendAborted || e instanceof FormDraftCopyAccountGoneError) {
      throw new ResendAborted();
    }
    const status = deps.statusOf(e);
    if (status === null || status >= 500) {
      console.warn(
        `[FORM-DRAFT-COPY] copy ${copy.key} kept for the next try: ${status ?? 'no answer'}`
      );
      return 'kept';
    }
    const conflict = deps.conflictOf(e);
    console.warn(
      `[FORM-DRAFT-COPY] copy ${copy.key} (base ${copy.baseRevision}) DROPPED: refused ${status}${conflict ? ', another writer moved the revision' : ''}`
    );
    live(deps);
    await deps.store.delete([copy.key]);
    deps.dropped(copy);
    return 'done';
  }
}

/**
 * The copy of the form the server holds at `revision` (written by save `saveId`, after the saves of
 * `recentSaveIds`), as an editor opening it should use it:
 * - `landed`: the copy's own save is in the revision's ancestry - nothing is owed, even when another
 *   writer built on it since;
 * - `use`: built on that revision, directly or through a predecessor that landed unanswered
 *   (re-based then);
 * - `stale`: built on a revision another writer moved past - its edits cannot be sent.
 */
export function copyAgainst(
  copy: FormDraftCopy,
  revision: { revision: number; saveId?: string | null; recentSaveIds?: string[] }
): { verdict: 'landed' } | { verdict: 'use'; copy: FormDraftCopy } | { verdict: 'stale' } {
  if (revision.saveId && copy.saveId === revision.saveId) return { verdict: 'landed' };
  if (revision.recentSaveIds?.includes(copy.saveId)) return { verdict: 'landed' };
  if (copy.baseRevision === revision.revision) return { verdict: 'use', copy };
  if (revision.saveId && copy.after.includes(revision.saveId)) {
    return { verdict: 'use', copy: { ...copy, baseRevision: revision.revision, after: [] } };
  }
  return { verdict: 'stale' };
}

/** The autosave's device copy of one form (`AutosaveDeviceCopy`), for `userId`. */
export interface DeviceCopy {
  keep(
    baseRevision: number,
    saveId: string,
    document: CreateFormPayload,
    after: string[]
  ): Promise<void>;
  sent(saveId: string): Promise<void>;
  drop(): Promise<void>;
}

/**
 * The autosave's device copy of a form for `userId`. `ids()` names it: the form's id once the server
 * holds it, and the create key of a create page (a copy kept before the form exists is created by
 * the resend).
 */
export function deviceCopyOf(
  userId: string,
  ids: () => { formId: string | null; clientCreateId: string | null }
): DeviceCopy {
  const store = formDraftCopyStore(userId);
  const keys = () => {
    const { formId, clientCreateId } = ids();
    return [formId, clientCreateId].filter((k): k is string => !!k);
  };
  return {
    keep: (baseRevision, saveId, document, after) => {
      const { formId, clientCreateId } = ids();
      const key = formId ?? clientCreateId;
      if (!key) return Promise.reject(new Error('a device copy needs a form id or a create key'));
      return store.put({ key, formId, clientCreateId, baseRevision, saveId, after, document });
    },
    sent: async (saveId) => {
      await store.deleteIfSent(keys(), saveId);
    },
    drop: () => store.delete(keys()),
  };
}
