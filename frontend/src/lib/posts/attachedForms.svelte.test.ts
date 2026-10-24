// @vitest-environment happy-dom
/**
 * A post's attached forms are each read ONCE, and drawn ONCE, whatever re-runs the card.
 *
 * Production, client 1.2.9, 2026-10-18: `/posts?feed=followed` fell into the page error boundary on
 * `each_key_duplicate`. A post carried two forms; the card's loader skipped a form only once its
 * answer was IN the list, so every re-run while an answer was in flight - the other form's answer
 * landing, or the card being handed the server's copy of the post - asked again and appended again.
 * The console showed each form's `GET /api/forms/<id>` and `/check` twice, then the crash.
 */
import { describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import {
  attachedFormSources,
  attachedFormsLoader,
  type AttachedFormReads,
  type AttachedFormSource,
} from './attachedForms.svelte';

/** A promise the test settles by hand, so the order of the answers is the test's, not a clock's. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Lets every settled promise run its callbacks, then flushes the effects they scheduled. A macrotask
 * turn drains the whole microtask queue, however deep the chain - an ORDER, not a duration.
 */
async function settle() {
  await new Promise<void>((r) => setTimeout(r, 0));
  flushSync();
}

function readsWithHandControlledChecks() {
  const checks = new Map<string, ReturnType<typeof deferred<{ hasSubmitted: boolean }>>[]>();
  const reads: AttachedFormReads = {
    getForm: vi.fn(async (id: string) => ({ id, title: `form ${id}` })),
    checkSubmission: vi.fn((id: string) => {
      const d = deferred<{ hasSubmitted: boolean }>();
      checks.set(id, [...(checks.get(id) ?? []), d]);
      return d.promise;
    }),
  };
  const answerAll = (id: string) => {
    for (const d of checks.get(id) ?? []) d.resolve({ hasSubmitted: false });
  };
  return { reads, answerAll };
}

describe('attachedFormsLoader', () => {
  it('two forms answering one after the other are each asked and drawn once', async () => {
    const { reads, answerAll } = readsWithHandControlledChecks();
    const sources = $state<AttachedFormSource[]>([
      { id: 'A', title: 'a' },
      { id: 'B', title: 'b' },
    ]);
    let loader!: ReturnType<typeof attachedFormsLoader>;
    const cleanup = $effect.root(() => {
      loader = attachedFormsLoader(() => sources, reads);
    });
    flushSync();

    answerAll('A');
    await settle();
    answerAll('B');
    await settle();

    expect(reads.checkSubmission).toHaveBeenCalledTimes(2);
    expect(loader.infos.map((fi) => fi.id)).toEqual(['A', 'B']);
    expect(loader.pending).toEqual([]);
    cleanup();
  });

  it('the card handed a new copy of the post while a read is out does not ask again', async () => {
    const { reads, answerAll } = readsWithHandControlledChecks();
    let sources = $state<AttachedFormSource[]>([{ id: 'A' }]);
    let loader!: ReturnType<typeof attachedFormsLoader>;
    const cleanup = $effect.root(() => {
      loader = attachedFormsLoader(() => sources, reads);
    });
    flushSync();
    await settle();
    // The server's copy replaces the painted one: same form, a new array.
    sources = [{ id: 'A' }];
    flushSync();
    await settle();
    answerAll('A');
    await settle();

    expect(reads.getForm).toHaveBeenCalledTimes(1);
    expect(reads.checkSubmission).toHaveBeenCalledTimes(1);
    expect(loader.infos.map((fi) => fi.id)).toEqual(['A']);
    cleanup();
  });

  it('draws the forms in the order the post names them, whichever answers first', async () => {
    const { reads, answerAll } = readsWithHandControlledChecks();
    const sources = $state<AttachedFormSource[]>([
      { id: 'A', title: 'a' },
      { id: 'B', title: 'b' },
    ]);
    let loader!: ReturnType<typeof attachedFormsLoader>;
    const cleanup = $effect.root(() => {
      loader = attachedFormsLoader(() => sources, reads);
    });
    flushSync();
    answerAll('B');
    await settle();
    expect(loader.infos.map((fi) => fi.id)).toEqual(['B']);
    expect(loader.pending).toEqual(['A']);
    answerAll('A');
    await settle();
    expect(loader.infos.map((fi) => fi.id)).toEqual(['A', 'B']);
    cleanup();
  });
});

describe('attachedFormsLoader sources', () => {
  it('builds the source list once per change, not once per reader of it', async () => {
    const { reads } = readsWithHandControlledChecks();
    const post = $state({ forms: [{ id: 'A', title: 'a' }] });
    const build = vi.fn(() => post.forms.map((f) => ({ id: f.id, title: f.title })));
    const cleanup = $effect.root(() => {
      const loader = attachedFormsLoader(build, reads);
      void loader.infos;
      void loader.pending;
    });
    await settle();
    expect(build).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

describe('attachedFormSources', () => {
  it('a post naming one form twice yields it once, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sources = attachedFormSources({
      id: 'p1',
      forms: [
        { id: 'A', title: 'a' },
        { id: 'A', title: 'a' },
      ],
    } as never);
    expect(sources.map((s) => s.id)).toEqual(['A']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('says it ONCE per post however often the list is rebuilt, and once per post id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dup = (id: string) =>
      ({ id, forms: [{ id: 'A' }, { id: 'A' }] }) as unknown as Parameters<
        typeof attachedFormSources
      >[0];
    for (let i = 0; i < 3; i++) attachedFormSources(dup('warn-once-1'));
    expect(warn).toHaveBeenCalledTimes(1);
    attachedFormSources(dup('warn-once-2'));
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('reads the legacy single attachedFormId only when the post has no forms list', () => {
    expect(attachedFormSources({ id: 'p', attachedFormId: 'L' } as never)).toEqual([{ id: 'L' }]);
    expect(
      attachedFormSources({
        id: 'p',
        forms: [{ id: 'A', title: 'a' }],
        attachedFormId: 'L',
      } as never)
    ).toEqual([{ id: 'A', title: 'a' }]);
  });
});
