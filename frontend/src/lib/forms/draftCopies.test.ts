/**
 * The device copy of a form's unsent edits over a real IndexedDB implementation (fake-indexeddb),
 * and the background resend that sends what a closed editor left (owner, 2026-11-08).
 *
 * Pinned: an answer to an older save never deletes a newer edit; a copy whose form the server never
 * answered is created first under its create key, re-keyed, then saved as the save it already is; a
 * copy that had landed is recognised from the 409 naming it; one whose PREDECESSOR landed unanswered
 * is re-based and sent - the whole sequence (lost answer, more typing, app closed) loses nothing; one
 * that reached no server stays and stops the pass; one another writer superseded is dropped and the
 * member told; a form open in an editor is left to that editor; sign-out erases it all, and a store
 * captured before it can neither recreate the database nor send under the next account.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FormDraftCopyAccountGoneError,
  FormDraftCopyStore,
  copyAgainst,
  deviceCopyOf,
  eraseFormDraftCopies,
  formDraftCopiesDbName,
  formDraftCopyStore,
  holdFormEditor,
  resendFormDraftCopies,
  type FormDraftCopy,
  type ResendDeps,
} from './draftCopies';
import { FormAutosave } from './autosave.svelte';
import { FormDraftConflictError } from './draftConflict';
import { setCurrentUserId } from '$lib/stores/userState.svelte';
import type { CreateFormPayload } from './api';

let n = 0;
const user = () => `user-${++n}`;
/** A store whose account counts as signed in (the session is not what these tests are about). */
const storeOf = (u = user()) => new FormDraftCopyStore(u, () => true);

const doc = (title: string) =>
  ({ title, basePrice: 0, currency: 'eur', items: [] }) as CreateFormPayload;

const copyOf = (formId: string, over: Partial<FormDraftCopy> = {}): FormDraftCopy => ({
  key: formId,
  formId,
  clientCreateId: null,
  baseRevision: 2,
  saveId: `${formId}-save`,
  after: [],
  document: doc(formId),
  ...over,
});

class Refused extends Error {
  constructor(readonly status: number) {
    super(`refused ${status}`);
  }
}

function deps(store: ResendDeps['store'], over: Partial<ResendDeps> = {}): ResendDeps {
  return {
    store,
    formDrafts: () => true,
    signedIn: () => true,
    createDraft: vi.fn(async (c: FormDraftCopy) => ({ id: `form-of-${c.key}` })),
    save: vi.fn(async () => undefined),
    statusOf: (e) =>
      e instanceof FormDraftConflictError ? 409 : e instanceof Refused ? e.status : null,
    conflictOf: (e) =>
      e instanceof FormDraftConflictError ? { revision: e.revision, saveId: e.saveId } : undefined,
    dropped: vi.fn(),
    ...over,
  };
}

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name ?? '');
}

afterEach(() => {
  setCurrentUserId(null);
  vi.restoreAllMocks();
});

describe('FormDraftCopyStore', () => {
  it('the answer to an older save never deletes the edit typed after it', async () => {
    const store = storeOf();
    await store.put(copyOf('f1', { saveId: 'older' }));
    await store.put(copyOf('f1', { saveId: 'newer' }));
    expect(await store.deleteIfSent(['f1'], 'older')).toBe(false);
    expect((await store.get('f1'))?.saveId).toBe('newer');
    expect(await store.deleteIfSent(['f1'], 'newer')).toBe(true);
    expect(await store.get('f1')).toBeNull();
  });

  it('a create answered re-keys its copy under the form, in one write', async () => {
    const store = storeOf();
    await store.put(copyOf('k1', { formId: null, clientCreateId: 'k1' }));
    await store.rekey('k1', 'f1');
    expect(await store.get('k1')).toBeNull();
    expect(await store.get('f1')).toMatchObject({ key: 'f1', formId: 'f1', clientCreateId: 'k1' });
    // A later keep under the form's id replaces it, and never leaves the create key's row behind.
    await store.put(copyOf('f1', { clientCreateId: 'k1', saveId: 'later' }));
    expect((await store.list()).map((c) => c.key)).toEqual(['f1']);
  });

  it('sign-out erases the account copies, and only that account', async () => {
    const leaving = user();
    const staying = user();
    setCurrentUserId(leaving);
    await formDraftCopyStore(leaving).put(copyOf('f1'));
    await storeOf(staying).put(copyOf('f2'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setCurrentUserId(null);
    await eraseFormDraftCopies(leaving, 'signed out');
    expect(await databaseNames()).not.toContain(formDraftCopiesDbName(leaving));
    expect((await storeOf(staying).list()).map((c) => c.formId)).toEqual(['f2']);
  });

  it('a store captured before the sign-out cannot recreate the erased database', async () => {
    const leaving = user();
    setCurrentUserId(leaving);
    // Captured at mount, as the editor's device copy is.
    const captured = formDraftCopyStore(leaving);
    await captured.put(copyOf('f1'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setCurrentUserId(null);
    await eraseFormDraftCopies(leaving, 'signed out');
    // The editor's teardown flush, on its way to /login: a late put.
    await expect(captured.put(copyOf('f1', { saveId: 'late' }))).rejects.toBeInstanceOf(
      FormDraftCopyAccountGoneError
    );
    // And after the next account signed in: refused all the same.
    setCurrentUserId(user());
    await expect(captured.list()).rejects.toBeInstanceOf(FormDraftCopyAccountGoneError);
    expect(await databaseNames()).not.toContain(formDraftCopiesDbName(leaving));
  });
});

describe('copyAgainst - what an opening editor does with a copy', () => {
  it('its own save wrote the revision: landed', () => {
    expect(copyAgainst(copyOf('f'), { revision: 3, saveId: 'f-save' }).verdict).toBe('landed');
  });

  it('built on the revision the server holds: used as it is', () => {
    expect(copyAgainst(copyOf('f'), { revision: 2, saveId: 'x' })).toEqual({
      verdict: 'use',
      copy: copyOf('f'),
    });
  });

  it('a predecessor it records wrote the revision: re-based on it', () => {
    const copy = copyOf('f', { after: ['s1'] });
    expect(copyAgainst(copy, { revision: 3, saveId: 's1' })).toEqual({
      verdict: 'use',
      copy: { ...copy, baseRevision: 3, after: [] },
    });
  });

  it('another writer moved the revision: stale', () => {
    expect(
      copyAgainst(copyOf('f', { after: ['s1'] }), { revision: 3, saveId: 'other' }).verdict
    ).toBe('stale');
  });
});

describe('resendFormDraftCopies', () => {
  it('creates the form the server never answered under its create key, then saves the copy as the save it already is', async () => {
    const store = storeOf();
    await store.put(copyOf('k1', { formId: null, clientCreateId: 'k1', baseRevision: 0 }));
    const d = deps(store);
    await resendFormDraftCopies(d);
    expect(d.createDraft).toHaveBeenCalledTimes(1);
    expect(d.save).toHaveBeenCalledWith(
      expect.objectContaining({ formId: 'form-of-k1', saveId: 'k1-save' })
    );
    expect(await store.list()).toEqual([]);
  });

  it('a copy that had landed: the 409 names it, and it goes', async () => {
    const store = storeOf();
    await store.put(copyOf('f1'));
    const d = deps(store, {
      save: vi.fn(async () => Promise.reject(new FormDraftConflictError(3, 'f1-save'))),
    });
    await resendFormDraftCopies(d);
    expect(await store.list()).toEqual([]);
    expect(d.dropped).not.toHaveBeenCalled();
  });

  it('a predecessor that landed unanswered: the copy is re-based on its revision and sent', async () => {
    const store = storeOf();
    await store.put(copyOf('f1', { after: ['s1'] }));
    const save = vi.fn(async (c: FormDraftCopy) => {
      if (c.baseRevision !== 3) throw new FormDraftConflictError(3, 's1');
    });
    const d = deps(store, { save });
    await resendFormDraftCopies(d);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ baseRevision: 3, after: [] }));
    expect(await store.list()).toEqual([]);
    expect(d.dropped).not.toHaveBeenCalled();
  });

  it('reaching no server keeps the copy and stops the pass', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = storeOf();
    await store.put(copyOf('a'));
    await store.put(copyOf('b'));
    const save = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
    await resendFormDraftCopies(deps(store, { save }));
    expect(save).toHaveBeenCalledTimes(1);
    expect((await store.list()).map((c) => c.formId).sort()).toEqual(['a', 'b']);
  });

  it("another writer's revision, or a form gone: the copy is dropped, logged, and the member told", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = storeOf();
    await store.put(copyOf('moved'));
    await store.put(copyOf('gone'));
    const save = vi.fn(async (c: FormDraftCopy) =>
      Promise.reject(
        c.formId === 'moved' ? new FormDraftConflictError(5, 'other-tab') : new Refused(404)
      )
    );
    const d = deps(store, { save });
    await resendFormDraftCopies(d);
    expect(await store.list()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DROPPED'));
    expect(d.dropped).toHaveBeenCalledTimes(2);
  });

  it('an account switch mid-pass: nothing further is sent nor written', async () => {
    const store = storeOf();
    await store.put(copyOf('a'));
    await store.put(copyOf('b'));
    let signedIn = true;
    const put = vi.spyOn(store, 'put');
    const del = vi.spyOn(store, 'deleteIfSent');
    const save = vi.fn(async () => {
      // The session ended while the first request was in flight; another account signs in.
      signedIn = false;
    });
    await resendFormDraftCopies(deps(store, { save, signedIn: () => signedIn }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(2);
  });

  it('leaves a form open in an editor to that editor', async () => {
    const store = storeOf();
    await store.put(copyOf('open'));
    const release = holdFormEditor('open');
    const d = deps(store);
    await resendFormDraftCopies(d);
    expect(d.save).not.toHaveBeenCalled();
    release();
    await resendFormDraftCopies(d);
    expect(d.save).toHaveBeenCalledTimes(1);
  });

  it('waits while the estate does not say it stores revisions', async () => {
    const store = storeOf();
    await store.put(copyOf('f1'));
    const d = deps(store, { formDrafts: () => false });
    await resendFormDraftCopies(d);
    expect(d.save).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);
  });
});

describe.each([
  ['a save whose answer was lost, more typing, the app closed', 'lost'],
  ['a save still on its way, more typing, the tab closed (it lands after)', 'in flight'],
] as const)('%s', (_title, how) => {
  /** A server holding one revision, compare-and-set like `PUT /forms/:id/draft`. */
  function server() {
    const state = {
      revision: 2,
      saveId: null as string | null,
      document: null as unknown,
      lose: true,
    };
    const write = (base: number, document: CreateFormPayload, saveId: string) => {
      if (base !== state.revision) throw new FormDraftConflictError(state.revision, state.saveId);
      state.revision += 1;
      state.saveId = saveId;
      state.document = document;
      return { revision: state.revision };
    };
    return { state, write };
  }

  /**
   * The editor up to the close: S1 lands - its answer lost, or never read because the page died
   * with it in flight - then D2 is typed and never sent.
   */
  async function typeThenClose(userId: string) {
    const srv = server();
    const ids = ['s1', 's2'];
    const autosave = new FormAutosave({
      revision: 2,
      delayMs: 60_000,
      newSaveId: () => ids.shift()!,
      device: deviceCopyOf(userId, () => ({ formId: 'f1', clientCreateId: null })),
      save: async (base, document, saveId) => {
        const out = srv.write(base, document, saveId);
        if (!srv.state.lose) return out;
        if (how === 'in flight') return new Promise<never>(() => {});
        throw new TypeError('Failed to fetch');
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    autosave.schedule(doc('one'));
    if (how === 'lost') {
      await autosave.flush();
      expect(autosave.status).toBe('offline');
    } else {
      void autosave.flush({ leaving: true });
      await vi.waitFor(() => expect(srv.state.saveId).toBe('s1'));
    }
    autosave.schedule(doc('two'));
    // The app is closed here: nothing more is sent; what the device holds is all that is left.
    const store = formDraftCopyStore(userId);
    await vi.waitFor(async () => expect((await store.get('f1'))?.saveId).toBe('s2'));
    srv.state.lose = false;
    return { srv, store };
  }

  it('reopened in the editor: the copy is re-based on its predecessor, nothing is dropped', async () => {
    const u = user();
    setCurrentUserId(u);
    const { srv, store } = await typeThenClose(u);
    const copy = (await store.get('f1'))!;
    expect(copy).toMatchObject({ baseRevision: 2, saveId: 's2', after: ['s1'] });
    const against = copyAgainst(copy, { revision: srv.state.revision, saveId: srv.state.saveId });
    expect(against).toMatchObject({
      verdict: 'use',
      copy: { baseRevision: 3, document: doc('two') },
    });
  });

  it('sent by the resend: the 409 naming the predecessor re-bases it, and the typing lands', async () => {
    const u = user();
    setCurrentUserId(u);
    const { srv, store } = await typeThenClose(u);
    const d = deps(store, {
      save: async (c) => srv.write(c.baseRevision, c.document, c.saveId),
    });
    await resendFormDraftCopies(d);
    expect(srv.state).toMatchObject({ revision: 4, saveId: 's2', document: doc('two') });
    expect(await store.list()).toEqual([]);
    expect(d.dropped).not.toHaveBeenCalled();
  });
});

describe('a copy whose own save landed and another writer built on it', () => {
  it('reopened: landed, by the ancestry, not stale', () => {
    expect(
      copyAgainst(copyOf('f', { saveId: 'mine' }), {
        revision: 7,
        saveId: 'theirs',
        recentSaveIds: ['mine', 'theirs'],
      }).verdict
    ).toBe('landed');
  });

  it('resent: cleared without a word to the member', async () => {
    const store = storeOf();
    await store.put(copyOf('f1', { saveId: 'mine' }));
    const d = deps(store, {
      save: vi.fn(async () =>
        Promise.reject(new FormDraftConflictError(7, 'theirs', ['mine', 'theirs']))
      ),
      conflictOf: (e) =>
        e instanceof FormDraftConflictError
          ? { revision: e.revision, saveId: e.saveId, recentSaveIds: e.recentSaveIds }
          : undefined,
    });
    await resendFormDraftCopies(d);
    expect(await store.list()).toEqual([]);
    expect(d.dropped).not.toHaveBeenCalled();
  });
});
