/**
 * THREE NUMBERS, AND EVERY WAY OF GETTING THEM WRONG IS SILENT.
 *
 * A published external-join base that has fallen behind the group's epoch locks every stateless
 * device out of that group, permanently: only a member's commit mints a base, the publish is a
 * follow-up that can be lost, and the epoch gate accepts `baseEpoch == activeEpoch` and nothing
 * else. Measured on production 2026-09-04 - four of the forty-three groups holding a base were
 * stale, every one of them by EXACTLY ONE epoch, two of them for five days with three devices
 * sitting `pending` on them.
 *
 * The repair is a comparison, and each mistake in it fails quietly:
 *
 *  - a missing `activeEpoch` read as `0` calls every base stale and makes every holder republish on
 *    every connection;
 *  - a missing `baseEpoch` read as `0` calls an UNPUBLISHED group stale, which is a different state
 *    wanting a Welcome and not a republish;
 *  - forgetting this device's OWN epoch replaces a stale base with an equally unusable one, and the
 *    group stays shut while the log says it was repaired.
 *
 * So the predicate is pure and every verdict is pinned here, including the three that do nothing.
 */
import { classifyBase, republishBaseIfStale } from './staleBase';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';

describe('classifyBase - what a holder should do about a published base', () => {
  it('republishes when the base is behind and this device holds the current tree', () => {
    // THE PRODUCTION SHAPE: exactly one epoch behind, which is one lost follow-up rather than drift.
    expect(classifyBase({ baseEpoch: 283, activeEpoch: 284, localEpoch: 284 })).toEqual({
      action: 'republish',
      baseEpoch: 283,
      activeEpoch: 284,
    });
  });

  it('does nothing when the base already describes the current epoch', () => {
    expect(classifyBase({ baseEpoch: 284, activeEpoch: 284, localEpoch: 284 })).toEqual({
      action: 'none',
      why: 'current',
    });
  });

  it('treats a base AHEAD of the active epoch as current, never as something to fix', () => {
    // The server's publish is monotonic and its active epoch is read separately, so the two can be
    // seen out of order. Republishing on `>` would fight the group's own progress.
    expect(classifyBase({ baseEpoch: 285, activeEpoch: 284, localEpoch: 285 })).toEqual({
      action: 'none',
      why: 'current',
    });
  });

  it('an UNPUBLISHED base is not a stale one - there is nothing to republish', () => {
    // A joiner asks a member for a Welcome in this state; a holder owes nothing. Reading `null` as
    // `0` here would make every never-published group look maximally stale.
    for (const baseEpoch of [null, undefined]) {
      expect(classifyBase({ baseEpoch, activeEpoch: 284, localEpoch: 284 })).toEqual({
        action: 'none',
        why: 'no-base-published',
      });
    }
  });

  it('a server that does not say leaves NOTHING known to be stale', () => {
    // A native client ships its own frontend, so an APK older than the server and a server older
    // than this client both exist. Defaulting the missing epoch to 0 would have every holder
    // republish every group on every connection.
    expect(classifyBase({ baseEpoch: 283, activeEpoch: undefined, localEpoch: 284 })).toEqual({
      action: 'none',
      why: 'server-did-not-say',
    });
    expect(classifyBase({ baseEpoch: null, activeEpoch: undefined, localEpoch: 0 })).toEqual({
      action: 'none',
      why: 'server-did-not-say',
    });
  });

  it('refuses to republish when THIS device is behind too, and names all three numbers', () => {
    // Publishing here would replace a stale base with another stale base, and the group would stay
    // shut while the log claimed a repair. Some other member is current - the fan-out is what
    // leaves them so - and this verdict is what names the wait.
    expect(classifyBase({ baseEpoch: 283, activeEpoch: 284, localEpoch: 283 })).toEqual({
      action: 'none',
      why: 'this-device-is-behind-too',
      baseEpoch: 283,
      activeEpoch: 284,
      localEpoch: 283,
    });
  });

  it('epoch 0 is a real epoch, not an absent one', () => {
    // A brand-new group sits at 0. `baseEpoch: 0` with `activeEpoch: 0` is current, and any
    // implementation using falsiness rather than a type check reports it as unpublished.
    expect(classifyBase({ baseEpoch: 0, activeEpoch: 0, localEpoch: 0 })).toEqual({
      action: 'none',
      why: 'current',
    });
    expect(classifyBase({ baseEpoch: 0, activeEpoch: 1, localEpoch: 1 })).toEqual({
      action: 'republish',
      baseEpoch: 0,
      activeEpoch: 1,
    });
  });
});

describe('republishBaseIfStale - the action, and what it says', () => {
  const row = (baseEpoch: number | null, activeEpoch: number) => ({
    groupId: 'group-1234abcd',
    baseEpoch,
    activeEpoch,
  });

  it('calls refreshGroupInfo exactly once and names both epochs', async () => {
    const lines: string[] = [];
    const mlsService = createMlsServiceStub({
      getEpoch: vi.fn().mockReturnValue(284),
      refreshGroupInfo: vi.fn().mockResolvedValue(undefined),
    });

    await republishBaseIfStale(mlsService, row(283, 284), (m) => lines.push(m));

    expect(mlsService.refreshGroupInfo).toHaveBeenCalledTimes(1);
    expect(mlsService.refreshGroupInfo).toHaveBeenCalledWith('group-1234abcd');
    const out = lines.join(' | ');
    expect(out).toContain('283');
    expect(out).toContain('284');
  });

  it('sends NOTHING and says nothing when the base is current - the common case is free', async () => {
    const lines: string[] = [];
    const mlsService = createMlsServiceStub({
      getEpoch: vi.fn().mockReturnValue(284),
      refreshGroupInfo: vi.fn().mockResolvedValue(undefined),
    });

    await republishBaseIfStale(mlsService, row(284, 284), (m) => lines.push(m));

    expect(mlsService.refreshGroupInfo).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('a holder that cannot help says so out loud rather than passing in silence', async () => {
    // The one dead end: the base is behind and nobody reachable can mint a usable one. Its rate is
    // what separates a stale base that is a moment from one that is a state.
    const lines: string[] = [];
    const mlsService = createMlsServiceStub({
      getEpoch: vi.fn().mockReturnValue(283),
      refreshGroupInfo: vi.fn().mockResolvedValue(undefined),
    });

    await republishBaseIfStale(mlsService, row(283, 284), (m) => lines.push(m));

    expect(mlsService.refreshGroupInfo).not.toHaveBeenCalled();
    expect(lines.join(' | ')).toContain('cannot mint a');
  });

  it('returns the verdict, so a caller can assert on the decision and not on a log line', async () => {
    const mlsService = createMlsServiceStub({ getEpoch: vi.fn().mockReturnValue(284) });

    await expect(republishBaseIfStale(mlsService, row(null, 284), () => {})).resolves.toEqual({
      action: 'none',
      why: 'no-base-published',
    });
  });
});
