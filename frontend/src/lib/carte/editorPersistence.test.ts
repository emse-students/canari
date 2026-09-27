import { describe, expect, it } from 'vitest';
import {
  createSerialSaver,
  layoutFingerprint,
  type LayoutFingerprintParts,
} from './editorPersistence';
import type { PositionedBubble } from './layout';

function bubble(over: Partial<PositionedBubble> = {}): PositionedBubble {
  return {
    assoId: 'a1',
    x: 10,
    y: 20,
    scale: 1,
    z: 1,
    colorOverride: null,
    showPresident: true,
    shape: 'blob-1',
    logoShape: 'square',
    ...over,
  };
}

function parts(over: Partial<LayoutFingerprintParts> = {}): LayoutFingerprintParts {
  return {
    titleColor: '#000000',
    scrimOpacity: 0,
    directoryVisible: true,
    bubbles: [bubble()],
    decorations: [],
    bgVersion: 0,
    ...over,
  };
}

describe('layoutFingerprint - opening a project must not look like an edit', () => {
  // The defect: the editor armed its autosave on hydration, so every open rewrote the layout 4 s
  // later - and a newly-created association was reseeded with a RANDOM shape on the way.
  it('is stable across rebuilds of the same state', () => {
    expect(layoutFingerprint(parts())).toBe(layoutFingerprint(parts()));
  });

  it('changes when a bubble moves', () => {
    expect(layoutFingerprint(parts({ bubbles: [bubble({ x: 11 })] }))).not.toBe(
      layoutFingerprint(parts())
    );
  });

  it.each([
    ['the title colour', { titleColor: '#ff0000' }],
    ['the scrim', { scrimOpacity: 40 }],
    ['the directory toggle', { directoryVisible: false }],
  ])('changes when %s changes', (_label, over) => {
    expect(layoutFingerprint(parts(over))).not.toBe(layoutFingerprint(parts()));
  });

  // The background image is megabytes and is fingerprinted by a counter, so replacing it has to
  // register even though the bytes never enter the string.
  it('changes when the background image is replaced, without carrying its bytes', () => {
    const swapped = layoutFingerprint(parts({ bgVersion: 1 }));
    expect(swapped).not.toBe(layoutFingerprint(parts()));
    expect(swapped.length).toBeLessThan(500);
  });
});

describe('createSerialSaver - a publish may not overtake a save', () => {
  /** A persist whose completion the test controls. */
  function controllable() {
    const calls: { resolve: () => void; reject: (e: Error) => void }[] = [];
    let started = 0;
    const persist = () => {
      started++;
      return new Promise<void>((resolve, reject) =>
        calls.push({ resolve, reject: (e) => reject(e) })
      );
    };
    return { persist, calls, started: () => started };
  }

  /** Lets every already-queued microtask run, so "has it started yet" is a fair question. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('waits for the save in flight instead of returning at once', async () => {
    const { persist, calls, started } = controllable();
    const saver = createSerialSaver(persist);

    const first = saver.save();
    const second = saver.save();
    let secondSettled = false;
    void second.then(() => (secondSettled = true));
    await flush();

    // One write in flight; the second has neither begun nor answered.
    expect(started()).toBe(1);
    expect(secondSettled).toBe(false);

    calls[0].resolve();
    expect(await first).toBe(true);
    await flush();
    expect(started()).toBe(2);

    calls[1].resolve();
    expect(await second).toBe(true);
  });

  it('reports a failure as false rather than rejecting', async () => {
    const saver = createSerialSaver(() => Promise.reject(new Error('offline')));
    await expect(saver.save()).resolves.toBe(false);
  });

  it('keeps running after a failure instead of stranding the queue', async () => {
    let attempt = 0;
    const saver = createSerialSaver(() => {
      attempt++;
      return attempt === 1 ? Promise.reject(new Error('offline')) : Promise.resolve();
    });

    expect(await saver.save()).toBe(false);
    expect(await saver.save()).toBe(true);
  });
});
