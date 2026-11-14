import { describe, expect, it } from 'vitest';
import {
  adoptDroppedPeople,
  bureauPicksByAssociation,
  createSerialSaver,
  layoutFingerprint,
  publishedPeopleByAssociation,
  type LayoutFingerprintParts,
} from './editorPersistence';
import type { PositionedBubble } from './layout';
import { flushMacrotask } from '../../test/flush';

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
  const flush = () => flushMacrotask();

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

describe('adoptDroppedPeople - the editor takes whom the server cut, from a save or a publish', () => {
  const member = (userId: string) => ({ userId });
  const people = (positioned: PositionedBubble[], parked: PositionedBubble[] = []) => ({
    positioned,
    parked,
    members: { a1: [member('gone'), member('kept')], a2: [member('other')] },
  });

  it('removes the bureau picks a SAVE dropped, and the roster entry, so the next save sends them no more', () => {
    const local = people([bubble({ selectedBureau: ['gone', 'kept'] }), bubble({ assoId: 'a2' })]);
    const sent = [{ assoId: 'a1', selectedBureau: ['gone', 'kept'] }, { assoId: 'a2' }];
    const stored = [{ assoId: 'a1', selectedBureau: ['kept'] }, { assoId: 'a2' }];
    const first = adoptDroppedPeople(
      local,
      bureauPicksByAssociation(sent),
      bureauPicksByAssociation(stored)
    );
    expect(first.dropped).toBe(1);
    expect(first.people.positioned[0].selectedBureau).toEqual(['kept']);
    expect(first.people.positioned[1]).toBe(local.positioned[1]);
    expect(first.people.members.a1).toEqual([member('kept')]);
    expect(first.people.members.a2).toBe(local.members.a2);
    // The next save sends the adopted state; the server keeps it whole, and nothing is dropped.
    const resent = bureauPicksByAssociation(first.people.positioned);
    const second = adoptDroppedPeople(first.people, resent, resent);
    expect(second).toEqual({ people: first.people, dropped: 0 });
    expect(second.people).toBe(first.people);
  });

  it('removes whom a PUBLISH cut from the cards and the rosters, from placed and parked bubbles alike', () => {
    const local = people(
      [bubble({ selectedBureau: ['gone', 'kept'] })],
      [bubble({ assoId: 'a2', selectedBureau: ['other'] })]
    );
    const sent = {
      units: [{ assoId: 'a1', cards: [{ userId: 'gone' }, { userId: 'kept' }] }],
      directory: {
        zones: [
          {
            assos: [
              { assoId: 'a1', line: 'x', members: [{ userId: 'gone' }, { userId: 'kept' }] },
              { assoId: 'a2', line: 'y', members: [{ userId: 'other' }] },
            ],
          },
        ],
      },
    };
    const stored = {
      units: [{ assoId: 'a1', cards: [{ userId: 'kept' }] }],
      directory: {
        zones: [
          {
            assos: [
              { assoId: 'a1', line: 'x', members: [{ userId: 'kept' }] },
              { assoId: 'a2', line: '', members: [] },
            ],
          },
        ],
      },
    };
    const out = adoptDroppedPeople(
      local,
      publishedPeopleByAssociation(sent),
      publishedPeopleByAssociation(stored)
    );
    expect(out.dropped).toBe(2);
    expect(out.people.positioned[0].selectedBureau).toEqual(['kept']);
    expect(out.people.parked[0].selectedBureau).toEqual([]);
    expect(out.people.members).toEqual({ a1: [member('kept')], a2: [] });
  });

  it('keeps a pick added while the request was in flight: it was never sent, so never dropped', () => {
    const local = people([bubble({ selectedBureau: ['gone', 'kept', 'added'] })]);
    const out = adoptDroppedPeople(
      local,
      bureauPicksByAssociation([{ assoId: 'a1', selectedBureau: ['gone', 'kept'] }]),
      bureauPicksByAssociation([{ assoId: 'a1', selectedBureau: ['kept'] }])
    );
    expect(out.people.positioned[0].selectedBureau).toEqual(['kept', 'added']);
  });

  it('changes nothing when the server stored what was sent, and reads a malformed document as naming nobody', () => {
    const local = people([bubble({ selectedBureau: ['kept'] })]);
    const layout = bureauPicksByAssociation([{ assoId: 'a1', selectedBureau: ['kept'] }]);
    expect(adoptDroppedPeople(local, layout, layout)).toEqual({ people: local, dropped: 0 });
    expect(publishedPeopleByAssociation(null).size).toBe(0);
    expect(publishedPeopleByAssociation({ units: 'x', directory: { zones: [null] } }).size).toBe(0);
  });
});
