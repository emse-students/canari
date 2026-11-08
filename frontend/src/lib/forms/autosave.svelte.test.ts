// @vitest-environment happy-dom
/**
 * THE EDITOR'S AUTOSAVE (owner, 2026-11-08): debounced, sent at once when the page is hidden or left,
 * one save in flight carrying the latest edit, offline edits kept and retried, a conflict stops it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormAutosave, AUTOSAVE_DELAY_MS, FORM_DRAFT_CONFLICT } from './autosave.svelte';
import { SocialApiError } from '$lib/associations/api';
import type { CreateFormPayload } from './api';

const doc = (title: string) =>
  ({ title, basePrice: 0, currency: 'eur', items: [] }) as CreateFormPayload;

/** A server holding one revision, answering compare-and-set like `PUT /forms/:id/draft`. */
function fakeServer() {
  const state = { revision: 0, document: null as CreateFormPayload | null, down: false };
  const save = vi.fn(async (base: number, document: CreateFormPayload) => {
    if (state.down) throw new TypeError('Failed to fetch');
    if (base !== state.revision) {
      throw new SocialApiError('moved', FORM_DRAFT_CONFLICT, 409);
    }
    state.revision += 1;
    state.document = document;
    return { revision: state.revision };
  });
  return { state, save };
}

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
    const autosave = new FormAutosave({ save: server.save });
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

  it('saves at once when the page is hidden, and when it is left', async () => {
    const server = fakeServer();
    const autosave = new FormAutosave({ save: server.save });
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
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('keeps one save in flight, and sends the edit typed meanwhile on the revision it produced', async () => {
    const server = fakeServer();
    let release!: () => void;
    const slow = vi.fn(async (base: number, d: CreateFormPayload) => {
      if (slow.mock.calls.length === 1) await new Promise<void>((r) => (release = r));
      return server.save(base, d);
    });
    const autosave = new FormAutosave({ save: slow });
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
    const autosave = new FormAutosave({ save: server.save });
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

  it('stops at a conflict rather than overwrite another tab, and sends nothing after it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = fakeServer();
    server.state.revision = 3; // Another tab saved meanwhile.
    const autosave = new FormAutosave({ save: server.save, revision: 1 });
    autosave.schedule(doc('Mine'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(autosave.status).toBe('conflict');
    autosave.schedule(doc('Mine again'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(server.save).toHaveBeenCalledTimes(1);
    expect(server.state.document).toBeNull();
  });

  it('builds on the new revision after a publication or a discard', async () => {
    const server = fakeServer();
    const autosave = new FormAutosave({ save: server.save, revision: 4, hasChanges: true });
    server.state.revision = 5;
    autosave.closed(5);
    expect([autosave.revision, autosave.hasChanges]).toEqual([5, false]);
    autosave.schedule(doc('After'));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(server.save).toHaveBeenCalledWith(5, doc('After'));
  });
});
