import { describe, expect, it, vi } from 'vitest';
import { publishAfterSave } from './publishAfterSave';

/** An editor whose state, saves and publishes the test drives. */
function editor() {
  let state = 'v1';
  let saved: string | null = null;
  const published: string[] = [];
  const releases: (() => void)[] = [];
  let saveOk = true;
  /** A save that pins the state at its START, as `persistLayout` does, and ends when released. */
  const save = vi.fn(async () => {
    const pinned = state;
    await new Promise<void>((r) => releases.push(r));
    if (!saveOk) return false;
    saved = pinned;
    return true;
  });
  const publish = publishAfterSave<string>({
    snapshot: () => ({ key: state, params: state }),
    save,
    savedKey: () => saved,
    publish: async (params) => void published.push(params),
  });
  return {
    publish,
    save,
    published,
    edit: (next: string) => (state = next),
    failSaves: () => (saveOk = false),
    finishSave: async () => {
      await Promise.resolve();
      await Promise.resolve();
      releases.shift()?.();
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('publishAfterSave', () => {
  it('a failed save publishes nothing', async () => {
    const e = editor();
    e.failSaves();
    const run = e.publish();
    await tick();
    await e.finishSave();
    expect(await run).toBe('save-failed');
    expect(e.published).toEqual([]);
  });

  it('a double click publishes once', async () => {
    const e = editor();
    const first = e.publish();
    const second = e.publish();
    expect(await second).toBe('busy');
    await tick();
    await e.finishSave();
    expect(await first).toBe('published');
    expect(e.published).toEqual(['v1']);
    expect(e.save).toHaveBeenCalledTimes(1);
  });

  it('an edit made during the save is not published unsaved', async () => {
    const e = editor();
    const run = e.publish();
    await tick();
    e.edit('v2-unsaved');
    await e.finishSave();
    expect(await run).toBe('published');
    expect(e.published).toEqual(['v1']);
  });

  it('a state that moved before the save began is saved again from a fresh snapshot', async () => {
    let state = 'v1';
    let saved: string | null = 'old';
    const published: string[] = [];
    let calls = 0;
    const run = publishAfterSave<string>({
      snapshot: () => ({ key: state, params: state }),
      // The first save wrote a state newer than the snapshot (it ran behind another save).
      save: async () => {
        calls++;
        if (calls === 1) state = 'v2';
        saved = state;
        return true;
      },
      savedKey: () => saved,
      publish: async (p) => void published.push(p),
    });
    expect(await run()).toBe('published');
    expect(calls).toBe(2);
    expect(published).toEqual(['v2']);
  });

  it('frees the guard when the publish is refused', async () => {
    let fail = true;
    const published: string[] = [];
    const run = publishAfterSave<string>({
      snapshot: () => ({ key: 'k', params: 'p' }),
      save: async () => true,
      savedKey: () => 'k',
      publish: async (p) => {
        if (fail) throw new Error('refused');
        published.push(p);
      },
    });
    await expect(run()).rejects.toThrow('refused');
    fail = false;
    expect(await run()).toBe('published');
    expect(published).toEqual(['p']);
  });
});
