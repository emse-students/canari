/**
 * The device copy of a form's unsent edits over a real IndexedDB implementation (fake-indexeddb),
 * and the background resend that sends what a closed editor left (owner, 2026-11-08).
 *
 * Pinned: an answer to an older save never deletes a newer edit; a copy whose form the server never
 * saw is created first, then saved as the save it already is; a copy that had landed is recognised
 * from the 409 naming it; one that reached no server stays and stops the pass; one another writer
 * superseded is dropped; a form open in an editor is left to that editor; sign-out erases it all.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  FormDraftCopyStore,
  eraseFormDraftCopies,
  formDraftCopyStore,
  holdFormEditor,
  resendFormDraftCopies,
  type FormDraftCopy,
  type ResendDeps,
} from './draftCopies';
import type { CreateFormPayload } from './api';

let n = 0;
const user = () => `user-${++n}`;

const copyOf = (formId: string, over: Partial<FormDraftCopy> = {}): FormDraftCopy => ({
  formId,
  baseRevision: 2,
  saveId: `${formId}-save`,
  document: { title: formId, basePrice: 0, currency: 'eur', items: [] } as CreateFormPayload,
  created: true,
  ...over,
});

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly conflictSaveId?: string | null
  ) {
    super(`refused ${status}`);
  }
}

function deps(store: FormDraftCopyStore, over: Partial<ResendDeps> = {}): ResendDeps {
  return {
    store,
    formDrafts: () => true,
    createDraft: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
    statusOf: (e) => (e instanceof Refused ? e.status : null),
    conflictSaveId: (e) => (e instanceof Refused ? e.conflictSaveId : undefined),
    ...over,
  };
}

describe('FormDraftCopyStore', () => {
  it('the answer to an older save never deletes the edit typed after it', async () => {
    const store = new FormDraftCopyStore(user());
    await store.put(copyOf('f1', { saveId: 'older' }));
    await store.put(copyOf('f1', { saveId: 'newer' }));
    expect(await store.deleteIfSent('f1', 'older')).toBe(false);
    expect((await store.get('f1'))?.saveId).toBe('newer');
    expect(await store.deleteIfSent('f1', 'newer')).toBe(true);
    expect(await store.get('f1')).toBeNull();
  });

  it('sign-out erases the account copies, and only that account', async () => {
    const leaving = user();
    const staying = user();
    await formDraftCopyStore(leaving).put(copyOf('f1'));
    await new FormDraftCopyStore(staying).put(copyOf('f2'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await eraseFormDraftCopies(leaving, 'signed out');
    expect(await new FormDraftCopyStore(leaving).list()).toEqual([]);
    expect((await new FormDraftCopyStore(staying).list()).map((c) => c.formId)).toEqual(['f2']);
  });
});

describe('resendFormDraftCopies', () => {
  it('creates the form the server never saw, then saves the copy as the save it already is', async () => {
    const store = new FormDraftCopyStore(user());
    await store.put(copyOf('new', { created: false, baseRevision: 0 }));
    const d = deps(store);
    await resendFormDraftCopies(d);
    expect(d.createDraft).toHaveBeenCalledTimes(1);
    expect(d.save).toHaveBeenCalledWith(expect.objectContaining({ saveId: 'new-save' }));
    expect(await store.list()).toEqual([]);
  });

  it('a copy that had landed: the 409 names it, and it goes', async () => {
    const store = new FormDraftCopyStore(user());
    await store.put(copyOf('f1'));
    const d = deps(store, { save: vi.fn(async () => Promise.reject(new Refused(409, 'f1-save'))) });
    await resendFormDraftCopies(d);
    expect(await store.list()).toEqual([]);
  });

  it('reaching no server keeps the copy and stops the pass', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new FormDraftCopyStore(user());
    await store.put(copyOf('a'));
    await store.put(copyOf('b'));
    const save = vi.fn(async () => Promise.reject(new TypeError('Failed to fetch')));
    await resendFormDraftCopies(deps(store, { save }));
    expect(save).toHaveBeenCalledTimes(1);
    expect((await store.list()).map((c) => c.formId).sort()).toEqual(['a', 'b']);
  });

  it("another writer's revision, or a form gone: the copy is dropped, and said", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new FormDraftCopyStore(user());
    await store.put(copyOf('moved'));
    await store.put(copyOf('gone'));
    const save = vi.fn(async (c: FormDraftCopy) =>
      Promise.reject(c.formId === 'moved' ? new Refused(409, 'other-tab') : new Refused(404))
    );
    await resendFormDraftCopies(deps(store, { save }));
    expect(await store.list()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DROPPED'));
  });

  it('leaves a form open in an editor to that editor', async () => {
    const store = new FormDraftCopyStore(user());
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
    const store = new FormDraftCopyStore(user());
    await store.put(copyOf('f1'));
    const d = deps(store, { formDrafts: () => false });
    await resendFormDraftCopies(d);
    expect(d.save).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);
  });
});
