// @vitest-environment happy-dom
/**
 * THE EDITOR'S AUTOSAVE (owner, 2026-11-08): debounced, sent at once when the page is hidden, left
 * or torn down by an in-app navigation, one save in flight carrying the latest edit, offline edits
 * kept on the device and retried, a save whose answer was lost adopted, a conflict stops it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormAutosave, AUTOSAVE_DELAY_MS, type AutosaveDeviceCopy } from './autosave.svelte';
import { FormDraftConflictError } from './draftConflict';
import type { CreateFormPayload } from './api';

const doc = (title: string) =>
  ({ title, basePrice: 0, currency: 'eur', items: [] }) as CreateFormPayload;

/**
 * A server holding one revision, answering compare-and-set like `PUT /forms/:id/draft`: its 409
 * carries the revision and the id of the save that wrote it. `loseAnswers`: the save LANDS, and the
 * answer never comes back (the link dropped on the way back).
 */
function fakeServer() {
  const state = {
    revision: 0,
    saveId: null as string | null,
    document: null as CreateFormPayload | null,
    down: false,
    loseAnswers: false,
  };
  const save = vi.fn(
    async (base: number, document: CreateFormPayload, saveId: string, _leaving: boolean) => {
      if (state.down) throw new TypeError('Failed to fetch');
      if (base !== state.revision) throw new FormDraftConflictError(state.revision, state.saveId);
      state.revision += 1;
      state.document = document;
      state.saveId = saveId;
      if (state.loseAnswers) throw new TypeError('Failed to fetch');
      return { revision: state.revision };
    }
  );
  return { state, save };
}

/** A device copy that records what the autosave asked of it. */
function fakeDevice() {
  const copy = { current: null as { base: number; saveId: string; title: string } | null };
  const device: AutosaveDeviceCopy = {
    keep: vi.fn(async (base: number, saveId: string, d: CreateFormPayload) => {
      copy.current = { base, saveId, title: d.title };
    }),
    sent: vi.fn(async (saveId: string) => {
      if (copy.current?.saveId === saveId) copy.current = null;
    }),
    drop: vi.fn(async () => {
      copy.current = null;
    }),
  };
  return { copy, device };
}

let ids = 0;
const newSaveId = () => `save-${++ids}`;

let cleanups: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('FormAutosave', () => {
  it('saves a burst of typing once, after the pause, with the last edit', async () => {
    const server = fakeServer();
    const autosave = new FormAutosave({ save: server.save, newSaveId });
    autosave.schedule(doc('G'));
    autosave.schedule(doc('Ga'));
    autosave.schedule(doc('Gala'));
    expect(autosave.status).toBe('saving');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1);
    expect(server.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(server.save).toHaveBeenCalledTimes(1);
    expect(server.state.document?.title).toBe('Gala');
    expect([autosave.status, autosave.revision, autosave.hasChanges]).toEqual(['saved', 1, true]);
  });

  it('saves at once when the page is hidden, and when it is left, asking the request to outlive it', async () => {
    const server = fakeServer();
    const autosave = new FormAutosave({ save: server.save, newSaveId });
    cleanups.push(autosave.attach(window));
    autosave.schedule(doc('Hidden'));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.save).toHaveBeenCalledTimes(1);

    autosave.schedule(doc('Left'));
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.save).toHaveBeenCalledTimes(2);
    expect(server.state.document?.title).toBe('Left');
    expect(server.save.mock.calls.map((c) => c[3])).toEqual([true, true]);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('an in-app navigation (no pagehide): tearing the editor down saves the last edit', async () => {
    const server = fakeServer();
    const autosave = new FormAutosave({ save: server.save, newSaveId });
    const detach = autosave.attach(window);
    autosave.schedule(doc('Typed just before "Retour"'));
    detach();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.state.document?.title).toBe('Typed just before "Retour"');
    // Nothing is sent twice when the debounce would have fired.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(server.save).toHaveBeenCalledTimes(1);
  });

  it('keeps one save in flight, and sends the edit typed meanwhile on the revision it produced', async () => {
    const server = fakeServer();
    let release!: () => void;
    const slow = vi.fn(
      async (base: number, d: CreateFormPayload, saveId: string, leaving: boolean) => {
        if (slow.mock.calls.length === 1) await new Promise<void>((r) => (release = r));
        return server.save(base, d, saveId, leaving);
      }
    );
    const autosave = new FormAutosave({ save: slow, newSaveId });
    autosave.schedule(doc('one'));
    const first = autosave.flush();
    await vi.advanceTimersByTimeAsync(0);
    autosave.schedule(doc('two'));
    const second = autosave.flush();
    release();
    await Promise.all([first, second]);
    expect(slow.mock.calls.map(([base, d]) => [base, d.title])).toEqual([
      [0, 'one'],
      [1, 'two'],
    ]);
    expect([autosave.status, autosave.revision]).toEqual(['saved', 2]);
  });

  it('keeps an edit that reached no server, says offline, and sends it when the link returns', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = fakeServer();
    const autosave = new FormAutosave({ save: server.save, newSaveId });
    cleanups.push(autosave.attach(window));
    server.state.down = true;
    autosave.schedule(doc('Offline edit'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(autosave.status).toBe('offline');
    expect(autosave.settled).toBe(false);
    server.state.down = false;
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.state.document?.title).toBe('Offline edit');
    expect([autosave.status, autosave.settled]).toEqual(['saved', true]);
  });

  it('a save that LANDED but whose answer was lost: adopted from the 409 that names it, never a conflict', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = fakeServer();
    const autosave = new FormAutosave({ save: server.save, newSaveId });
    server.state.loseAnswers = true;
    autosave.schedule(doc('Landed'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect([autosave.status, server.state.revision]).toEqual(['offline', 1]);
    server.state.loseAnswers = false;
    autosave.schedule(doc('Landed, then more'));
    await autosave.flush();
    // The 409 named the lost save: it is adopted as revision 1, and the newer edit sent on it.
    expect(server.save.mock.calls.map(([base, d]) => [base, d.title])).toEqual([
      [0, 'Landed'],
      [0, 'Landed, then more'],
      [1, 'Landed, then more'],
    ]);
    expect([autosave.status, autosave.revision, server.state.document?.title]).toEqual([
      'saved',
      2,
      'Landed, then more',
    ]);
  });

  it('the same save sent again (the background resend got there first): adopted, nothing more sent', async () => {
    const server = fakeServer();
    server.state.revision = 4;
    server.state.saveId = 'kept-on-device';
    const autosave = new FormAutosave({ save: server.save, revision: 3, newSaveId });
    autosave.resume(doc('From the device'), 'kept-on-device');
    await autosave.flush();
    expect([autosave.status, autosave.revision, autosave.hasChanges]).toEqual(['saved', 4, true]);
    expect(server.save).toHaveBeenCalledTimes(1);
  });

  it('stops at a conflict rather than overwrite another tab, sends nothing after it, and keeps the device copy of the edits still on screen', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = fakeServer();
    server.state.revision = 3; // Another tab saved meanwhile.
    server.state.saveId = 'other-tab';
    const { copy, device } = fakeDevice();
    const autosave = new FormAutosave({ save: server.save, revision: 1, device, newSaveId });
    autosave.schedule(doc('Mine'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(autosave.status).toBe('conflict');
    expect(copy.current).toMatchObject({ base: 1, title: 'Mine' });
    expect(device.drop).not.toHaveBeenCalled();
    autosave.schedule(doc('Mine again'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(server.save).toHaveBeenCalledTimes(1);
    expect(server.state.document).toBeNull();
  });

  it('keeps every edit on the device until its save lands, on the base it is sent on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = fakeServer();
    const { copy, device } = fakeDevice();
    const autosave = new FormAutosave({ save: server.save, device, newSaveId });
    server.state.down = true;
    autosave.schedule(doc('Kept'));
    expect(copy.current).toMatchObject({ base: 0, title: 'Kept' });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    // Reached no server: still on the device, ready for a page reopened later.
    expect(copy.current).toMatchObject({ base: 0, title: 'Kept' });
    server.state.down = false;
    await autosave.flush();
    expect(copy.current).toBeNull();
  });

  it('builds on the new revision after a publication or a discard, and drops the device copy', async () => {
    const server = fakeServer();
    const { device } = fakeDevice();
    const autosave = new FormAutosave({
      save: server.save,
      revision: 4,
      hasChanges: true,
      device,
      newSaveId: () => 'after',
    });
    server.state.revision = 5;
    autosave.closed(5, 'published');
    expect([autosave.revision, autosave.hasChanges]).toEqual([5, false]);
    expect(device.drop).toHaveBeenCalledTimes(1);
    autosave.schedule(doc('After'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(server.save).toHaveBeenCalledWith(5, doc('After'), 'after', false);
  });

  it('keeps an edit typed while the publication ran: the first save of the next revision', async () => {
    const server = fakeServer();
    const { copy, device } = fakeDevice();
    const autosave = new FormAutosave({
      save: server.save,
      revision: 4,
      hasChanges: true,
      device,
      newSaveId: () => 'typed-meanwhile',
    });
    // Typed after the page's flush, while "Publier" awaited the server.
    autosave.schedule(doc('Typed meanwhile'));
    server.state.revision = 5;
    autosave.closed(5, 'published');
    expect(device.drop).not.toHaveBeenCalled();
    expect(copy.current).toMatchObject({ base: 5, title: 'Typed meanwhile' });
    await autosave.flush();
    expect(server.save).toHaveBeenCalledWith(5, doc('Typed meanwhile'), 'typed-meanwhile', false);
    expect([autosave.status, autosave.hasChanges]).toEqual(['saved', true]);
  });

  it('a discard drops an edit typed while it ran: the page shows the published form again', async () => {
    const server = fakeServer();
    const { device } = fakeDevice();
    const autosave = new FormAutosave({ save: server.save, revision: 4, device, newSaveId });
    autosave.schedule(doc('Thrown away'));
    autosave.closed(5, 'discarded');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(server.save).not.toHaveBeenCalled();
    expect(device.drop).toHaveBeenCalledTimes(1);
  });

  it('an edit whose save left DURING the publication: carried onto the new revision, never a conflict', async () => {
    const server = fakeServer();
    const { copy, device } = fakeDevice();
    let refuse: (e: unknown) => void = () => {};
    const save = vi.fn(
      (base: number, document: CreateFormPayload, saveId: string, leaving: boolean) =>
        save.mock.calls.length === 1
          ? new Promise<{ revision: number }>((_r, reject) => (refuse = reject))
          : server.save(base, document, saveId, leaving)
    );
    const autosave = new FormAutosave({ save, revision: 4, hasChanges: true, device, newSaveId });
    // Typed while "Publier" awaited the server; the 1.5 s timer fires before it answers.
    autosave.schedule(doc('Typed meanwhile'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledWith(4, doc('Typed meanwhile'), expect.any(String), false);
    const saveId = save.mock.calls[0][2];
    // The publication answers first: revision 5, and the copy follows the edit onto it.
    server.state.revision = 5;
    autosave.closed(5, 'published');
    expect(device.drop).not.toHaveBeenCalled();
    expect(copy.current).toMatchObject({ base: 5, saveId, title: 'Typed meanwhile' });
    // Then the save sent on revision 4 is refused: nobody reads that answer.
    refuse(new FormDraftConflictError(5, null));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith(5, doc('Typed meanwhile'), saveId, false);
    await vi.waitFor(() => expect(autosave.status).toBe('saved'));
    expect([autosave.revision, autosave.hasChanges]).toEqual([6, true]);
    expect(device.drop).not.toHaveBeenCalled();
    expect(copy.current).toBeNull();
  });

  it('a discard during a save on its way: the edit goes, and the refusal that follows is no conflict', async () => {
    const { device } = fakeDevice();
    let refuse: (e: unknown) => void = () => {};
    const save = vi.fn(() => new Promise<{ revision: number }>((_r, reject) => (refuse = reject)));
    const autosave = new FormAutosave({ save, revision: 4, device, newSaveId });
    autosave.schedule(doc('Thrown away'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    autosave.closed(5, 'discarded');
    refuse(new FormDraftConflictError(5, null));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(autosave.status).toBe('saved');
    expect(device.drop).toHaveBeenCalledTimes(1);
  });

  it('a save on its way is in the "after" of every copy kept meanwhile', async () => {
    const after: string[][] = [];
    const device: AutosaveDeviceCopy = {
      keep: vi.fn(async (_b: number, _s: string, _d: CreateFormPayload, a: string[]) => {
        after.push(a);
      }),
      sent: vi.fn(async () => {}),
      drop: vi.fn(async () => {}),
    };
    let answer: (v: { revision: number }) => void = () => {};
    const save = vi.fn(() => new Promise<{ revision: number }>((r) => (answer = r)));
    const ids = ['s1', 's2'];
    const autosave = new FormAutosave({ save, revision: 2, device, newSaveId: () => ids.shift()! });
    autosave.schedule(doc('One'));
    const flushing = autosave.flush();
    // s1 is on its way; the manager types on.
    autosave.schedule(doc('Two'));
    expect(after.at(-1)).toEqual(['s1']);
    answer({ revision: 3 });
    // Answered: s2 goes next, and the copy of it no longer names s1.
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(after.at(-1)).toEqual([]);
    void flushing;
  });
});
