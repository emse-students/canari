/**
 * THREE NUMBERS, AND EVERY WAY OF GETTING THEM WRONG IS SILENT.
 *
 * A published external-join base that has fallen behind the group's epoch locks every stateless
 * device out of that group, permanently: only a member can mint a base, a STAGED commit's base
 * arrives as a follow-up that can be lost (its commit is unapplied at submit time, so it cannot
 * travel inside the submission the way an external join's does), and the epoch gate accepts
 * `baseEpoch == activeEpoch` and nothing else.
 * Measured on production 2026-09-04 - four of the forty-three groups holding a base were
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
import { answerBaseRefreshRequest, classifyBase, republishBaseIfStale } from './staleBase';
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
      refreshGroupInfo: vi.fn().mockResolvedValue({ stored: true, baseEpoch: 284 }),
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
      refreshGroupInfo: vi.fn().mockResolvedValue({ stored: true, baseEpoch: 284 }),
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
      refreshGroupInfo: vi.fn().mockResolvedValue({ stored: true, baseEpoch: 284 }),
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

/**
 * R-D3 - ONE PUBLISHER SINCE #571, AND NOW ONE READING OF ITS ANSWER.
 *
 * "Did my base land" is the server's to answer and it always was: `putGroupInfo` is strictly
 * monotonic and reports `stored: false` for a base that was not newer. #571 made
 * `publishCurrentBase` the single publisher and threaded that answer out through `refreshGroupInfo`
 * - and then TWO callers were entitled to describe it, which is the duplicate. `republishBaseIfStale`
 * discarded it outright: it logged *republishing from the tree this device holds* and never said
 * whether the tree was taken. The `base_refresh_request` responder read it, and lived inside
 * `sessionAuth` where nothing could call it - the half of the pair with no coverage of any kind.
 *
 * The table drives BOTH repairs over the SAME three server answers. What it asserts is that neither
 * one claims something the server refused, and that they say it in the same words: a second wording
 * for one answer is how two callers come to disagree about what happened.
 */
describe('both base repairs report what the server did, in one wording (R-D3)', () => {
  const STALE = { groupId: 'group-1234abcd', baseEpoch: 283, activeEpoch: 284 };

  /** A stub whose publish answers `published`, with a tree current enough to be asked to publish. */
  const holding = (published: { stored: boolean; baseEpoch: number } | null) =>
    createMlsServiceStub({
      getEpoch: vi.fn().mockReturnValue(284),
      isGroupActive: vi.fn().mockResolvedValue(true),
      refreshGroupInfo: vi.fn().mockResolvedValue(published),
    });

  const REPAIRS = [
    {
      name: "republishBaseIfStale - the holder's ordinary read",
      run: (mls: ReturnType<typeof createMlsServiceStub>, log: (m: string) => void) =>
        republishBaseIfStale(mls, STALE, log),
    },
    {
      name: 'answerBaseRefreshRequest - a device locked out right now',
      run: (mls: ReturnType<typeof createMlsServiceStub>, log: (m: string) => void) =>
        answerBaseRefreshRequest(mls, STALE.groupId, log),
    },
  ];

  it('drives two distinct repairs, not one written twice', () => {
    expect(new Set(REPAIRS.map((r) => r.run.toString())).size).toBe(REPAIRS.length);
  });

  for (const repair of REPAIRS) {
    it(`${repair.name} names the epoch the server TOOK`, async () => {
      const lines: string[] = [];
      // The epoch it published, not the one it is at now: a later `getEpoch` answers a different
      // question, and reporting that one names a base that was never stored.
      await repair.run(holding({ stored: true, baseEpoch: 284 }), (m) => lines.push(m));

      expect(lines.join(' | ')).toContain('the server took it - the base now describes epoch 284');
    });

    it(`${repair.name} does NOT claim a republish the server refused`, async () => {
      const lines: string[] = [];
      // CURRENT LOCALLY, REFUSED BY THE SERVER - the only way this answer reaches
      // `republishBaseIfStale`, since a device that KNOWS it is behind never publishes (that is
      // `this-device-is-behind-too`, and it costs no round trip). Here the base moved between the
      // read and the publish. The responder has no such guess and meets this answer on any ask.
      await repair.run(holding({ stored: false, baseEpoch: 284 }), (m) => lines.push(m));

      const out = lines.join(' | ');
      expect(out).toContain('the server KEPT the base it had');
      expect(out).toContain('not newer');
      expect(out).not.toContain('the server took it');
    });

    it(`${repair.name} treats a publish that never landed as NEITHER`, async () => {
      const lines: string[] = [];
      await repair.run(holding(null), (m) => lines.push(m));

      const out = lines.join(' | ');
      expect(out).toContain('did not land');
      // A failure proves nothing about the base. Reading it as the refusal is what turns a dropped
      // packet into "no holder that has connected can repair this group".
      expect(out).not.toContain('the server took it');
      expect(out).not.toContain('the server KEPT the base it had');
    });
  }

  it('the two repairs report an answer in the SAME words, differing only by their tag', async () => {
    const say = async (repair: (typeof REPAIRS)[number]) => {
      const lines: string[] = [];
      await repair.run(holding({ stored: false, baseEpoch: 284 }), (m) => lines.push(m));
      return lines.filter((l) => l.includes('KEPT')).map((l) => l.replace(/^\[[A-Z_]+\] /, ''));
    };

    // ONE ANSWER, ONE SENTENCE. The tag says which caller is speaking and nothing else does, so a
    // repair that invents its own phrasing for the same server verdict fails here.
    const holder = await say(REPAIRS[0]);
    // A comparison of two empty lists is a comparison of nothing - it would agree just as loudly if
    // NEITHER repair reported the refusal at all, which is the defect this whole block is about.
    expect(holder).toHaveLength(1);
    expect(holder).toEqual(await say(REPAIRS[1]));
  });

  it('the responder publishes nothing when it holds no state, and says which', async () => {
    const lines: string[] = [];
    const mls = createMlsServiceStub({
      isGroupActive: vi.fn().mockResolvedValue(false),
      refreshGroupInfo: vi.fn(),
    });

    const answer = await answerBaseRefreshRequest(mls, STALE.groupId, (m) => lines.push(m));

    // Not the requester's fault and not silent: this device was elected and cannot help, so the ask
    // has to reach somebody else.
    expect(mls.refreshGroupInfo).not.toHaveBeenCalled();
    expect(answer).toBe('no-local-state');
    expect(lines.join(' | ')).toContain('no active MLS state');
  });

  it('the responder never throws into the socket handler that called it', async () => {
    const lines: string[] = [];
    const mls = createMlsServiceStub({
      isGroupActive: vi.fn().mockRejectedValue(new Error('wasm is gone')),
    });

    // It runs inside a WebSocket message handler. A throw there is an unhandled rejection in a path
    // that has nothing to do with this group.
    await expect(
      answerBaseRefreshRequest(mls, STALE.groupId, (m) => lines.push(m))
    ).resolves.toBeNull();
    expect(lines.join(' | ')).toContain('refresh failed');
  });

  it('sessionAuth wires the responder rather than keeping a second copy of it', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(
      join(process.cwd(), 'src', 'lib', 'composables', 'session', 'sessionAuth.ts'),
      'utf8'
    );
    expect(src).toContain('await answerBaseRefreshRequest(ctx.ensureMls(), groupId, cb.log);');
    // The reading lived here, untestable. Nothing in that file may describe a publish again.
    expect(src).not.toMatch(/\[BASE_REFRESH\][^\n]*republished at epoch/);
    expect(src).not.toContain('.refreshGroupInfo(');
  });
});
