import type {
  GraineRotationAnchor,
  IStorage,
  StoredGraineSession,
  StoredGraineV2,
} from '$lib/db/types';
import type { GraineRunReading } from '$lib/mls-client/IMlsService';
import { byNewestSession } from '$lib/db/graineCodec';
import {
  GRAINE_REUSED_ROTATE_AFTER_MESSAGES,
  GRAINE_REUSED_ROTATE_AFTER_MS,
  GRAINE_ROTATE_AFTER_MESSAGES,
  GRAINE_ROTATE_AFTER_MS,
} from '$lib/crypto/graineConstants';
import { GraineInputError } from '$lib/crypto/graine';
import {
  graineOutboundVerdict,
  reserveOutboundSlot,
  type GraineOutboundDeps,
} from './sessionManager';

/**
 * The outbound Graine session manager (WP-30).
 *
 * Three things are pinned here, and each one is a silent failure if it goes: that a message index
 * is handed out exactly once even under concurrent sends (reusing one reuses an AES-GCM key), that
 * a session is never persisted before its seed has actually reached the community (a persisted,
 * undistributed session is reused for ever and nobody can read a word of it), and that a
 * departure - read from the key group's departure tracker - forces a new session while an Add only
 * re-distributes the one in hand (`docs/wiki/protocols/graine-removal-tracker.md`).
 */

const NOW = 1_700_000_000_000;
const SCOPE = { workspaceId: 'ws-1', channelId: 'chan-1', senderId: 'alice' };
/** What `distribute` answers: the frame it posted, which the session keeps (section 19). */
const FRAME = { groupId: 'dist-group', protoB64: 'ZnJhbWU=' };
/** What `endorse` answers: a v2 half this device can sign with (WP-G2-5). */
const V2: StoredGraineV2 = {
  minterDeviceId: 'dev-a',
  signingPublicKeyB64: 'cGs=',
  endorsementB64: 'ZW5k',
  signingSecretKeyB64: 'c2s=',
};
/** The key group's tracker at epoch 4, as `graineRun` answers it. */
const RUN: GraineRunReading = { runId: 'run-A', epoch: 4, epochFingerprint: 'fp-4' };
/** A session minted in that run, at that epoch. */
const ANCHOR: GraineRotationAnchor = {
  runId: 'run-A',
  epochFingerprint: 'fp-4',
  redistributed: false,
};

/** An in-memory `IStorage` holding only what the manager touches, newest-first like the real ones. */
function fakeStorage(seed: StoredGraineSession[] = []) {
  const rows = new Map<string, StoredGraineSession>(seed.map((s) => [s.sessionId, s]));
  const saved: StoredGraineSession[] = [];
  return {
    rows,
    saved,
    storage: {
      getGraineSessions: async (channelId: string) =>
        [...rows.values()].filter((s) => s.channelId === channelId).sort(byNewestSession),
      saveGraineSession: async (session: StoredGraineSession) => {
        rows.set(session.sessionId, session);
        saved.push(session);
      },
    } as unknown as IStorage,
  };
}

function session(overrides: Partial<StoredGraineSession> = {}): StoredGraineSession {
  return {
    workspaceId: 'ws-1',
    channelId: 'chan-1',
    senderId: 'alice',
    sessionId: 'sess-1',
    seedB64: 'AAAA',
    firstIndex: 0,
    createdAt: NOW,
    sentCount: 0,
    distributionEpoch: 4,
    distributionFrame: FRAME,
    v2: V2,
    rotationAnchor: ANCHOR,
    ...overrides,
  };
}

function deps(storage: IStorage, overrides: Partial<GraineOutboundDeps> = {}): GraineOutboundDeps {
  return {
    storage,
    deviceKeyB64: 'device-key',
    distributionEpoch: 4,
    readRun: vi.fn().mockResolvedValue(RUN),
    distribute: vi.fn().mockResolvedValue(FRAME),
    endorse: vi.fn().mockResolvedValue(V2),
    now: () => NOW,
    ...overrides,
  };
}

describe('what the session in hand may do next', () => {
  const at = { run: RUN, now: NOW };

  it('is reused as it is at the epoch it was last distributed at', () => {
    expect(graineOutboundVerdict(session(), at)).toBe('reuse');
  });

  it('is RE-DISTRIBUTED, not rotated, when the epoch moved and the run did not (an Add)', () => {
    // THE PRODUCTION COST THIS CLOSES: every device joining the key group commits, and until
    // 2026-10-22 each of those commits minted a seed - one per two messages.
    const moved = { run: { ...RUN, epoch: 5, epochFingerprint: 'fp-5' }, now: NOW };
    expect(graineOutboundVerdict(session(), moved)).toBe('redistribute');
  });

  it('rotates when the run changed - a removal, a new user, or a move the tracker did not see', () => {
    // The MLS layer replaces the run on all three; at this layer they are one fact.
    const departed = { run: { runId: 'run-B', epoch: 5, epochFingerprint: 'fp-5' }, now: NOW };
    expect(graineOutboundVerdict(session({ sentCount: 1 }), departed)).toBe('rotate');
  });

  it('never reads an epoch NUMBER as the epoch: same number, other fingerprint, other run rotates', () => {
    // A re-bootstrapped key group reaches the number the session was minted at with other secrets,
    // and possibly without a device that held this seed.
    const rebuilt = {
      run: { runId: 'run-B', epoch: 4, epochFingerprint: 'fp-4-rebuilt' },
      now: NOW,
    };
    expect(graineOutboundVerdict(session(), rebuilt)).toBe('rotate');
  });

  it('rotates for each unconditional cause, one at a time', () => {
    expect(graineOutboundVerdict(null, at)).toBe('rotate');
    expect(graineOutboundVerdict(session({ sentCount: GRAINE_ROTATE_AFTER_MESSAGES }), at)).toBe(
      'rotate'
    );
    expect(graineOutboundVerdict(session({ createdAt: NOW - GRAINE_ROTATE_AFTER_MS }), at)).toBe(
      'rotate'
    );
  });

  it('rotates a session minted before the tracker, rather than trusting an epoch number', () => {
    expect(graineOutboundVerdict(session({ rotationAnchor: undefined }), at)).toBe('rotate');
  });

  it('rotates a session minted before its frame was kept, since every message now carries one', () => {
    expect(graineOutboundVerdict(session({ distributionFrame: undefined }), at)).toBe('rotate');
  });

  it('rotates a v1 session, and a v2 one whose secret is not here to sign with (WP-G2-5)', () => {
    expect(graineOutboundVerdict(session({ v2: undefined }), at)).toBe('rotate');
    const restored = session({ v2: { ...V2, signingSecretKeyB64: undefined } });
    expect(graineOutboundVerdict(restored, at)).toBe('rotate');
  });

  it('holds a re-distributed session to the tighter caps, counted from its mint', () => {
    const reused = (overrides: Partial<StoredGraineSession>) =>
      session({ rotationAnchor: { ...ANCHOR, redistributed: true }, ...overrides });
    expect(graineOutboundVerdict(reused({ sentCount: 10 }), at)).toBe('reuse');
    expect(
      graineOutboundVerdict(reused({ sentCount: GRAINE_REUSED_ROTATE_AFTER_MESSAGES }), at)
    ).toBe('rotate');
    expect(
      graineOutboundVerdict(reused({ createdAt: NOW - GRAINE_REUSED_ROTATE_AFTER_MS }), at)
    ).toBe('rotate');
  });

  it('rotates rather than re-distribute a session already past the tighter caps', () => {
    const moved = { run: { ...RUN, epoch: 5, epochFingerprint: 'fp-5' }, now: NOW };
    expect(
      graineOutboundVerdict(session({ sentCount: GRAINE_REUSED_ROTATE_AFTER_MESSAGES }), moved)
    ).toBe('rotate');
    expect(
      graineOutboundVerdict(session({ createdAt: NOW - GRAINE_REUSED_ROTATE_AFTER_MS }), moved)
    ).toBe('rotate');
  });
});

describe('reserving a slot', () => {
  it('refuses to seal anything when the distribution epoch is not a real epoch', async () => {
    const { storage } = fakeStorage();
    // A caller that has not joined the group has no epoch to give. Sealing anyway would produce a
    // session no later roster check could ever judge.
    await expect(
      reserveOutboundSlot(deps(storage, { distributionEpoch: Number.NaN }), SCOPE)
    ).rejects.toBeInstanceOf(GraineInputError);
  });

  it('mints, distributes, then persists - in that order', async () => {
    const { storage, saved } = fakeStorage();
    const order: string[] = [];
    const d = deps(storage, {
      distribute: vi.fn().mockImplementation(async () => {
        order.push('distribute');
        return FRAME;
      }),
    });
    const spySave = vi.spyOn(storage, 'saveGraineSession').mockImplementation(async (s) => {
      order.push('save');
      saved.push(s);
    });

    const slot = await reserveOutboundSlot(d, SCOPE);

    expect(order).toEqual(['distribute', 'save']);
    expect(slot.minted).toBe(true);
    expect(slot.index).toBe(0);
    expect(slot.session.sentCount).toBe(1);
    expect(slot.session.distributionEpoch).toBe(4);
    // The frame the distribution answered is what every message under this session will carry.
    expect(slot.session.distributionFrame).toEqual(FRAME);
    expect(d.distribute).toHaveBeenCalledWith(expect.objectContaining({ sentCount: 0 }));
    spySave.mockRestore();
  });

  it('endorses a minted session BEFORE distributing it, so the seed travels as v2', async () => {
    const { storage } = fakeStorage();
    const d = deps(storage);

    const slot = await reserveOutboundSlot(d, SCOPE);

    expect(d.endorse).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'alice' }));
    // The distributed session already carries its v2 half: a v2 seed handed over without its
    // endorsement is refused by every reader.
    expect(d.distribute).toHaveBeenCalledWith(expect.objectContaining({ v2: V2 }));
    expect(slot.session.v2).toEqual(V2);
  });

  it('distributes and persists NOTHING when the endorsement could not be made', async () => {
    const { storage, saved } = fakeStorage();
    const d = deps(storage, { endorse: vi.fn().mockRejectedValue(new Error('no credential')) });

    await expect(reserveOutboundSlot(d, SCOPE)).rejects.toThrow('no credential');
    expect(d.distribute).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it('persists NOTHING when the seed could not be distributed', async () => {
    const { storage, saved } = fakeStorage();
    const d = deps(storage, { distribute: vi.fn().mockRejectedValue(new Error('offline')) });

    await expect(reserveOutboundSlot(d, SCOPE)).rejects.toThrow('offline');
    // Keeping it would make it the current session on the next send, and every message sealed
    // under it would be unreadable by everyone, permanently.
    expect(saved).toHaveLength(0);
  });

  it('reuses the session in hand and burns the next index', async () => {
    const { storage, saved } = fakeStorage([session({ sentCount: 7 })]);
    const d = deps(storage);

    const slot = await reserveOutboundSlot(d, SCOPE);

    expect(slot.minted).toBe(false);
    expect(slot.index).toBe(7);
    expect(d.distribute).not.toHaveBeenCalled();
    expect(saved[0].sentCount).toBe(8);
  });

  it('starts from firstIndex, so a session handed over mid-way is not rewound', async () => {
    const { storage } = fakeStorage([session({ firstIndex: 40, sentCount: 2 })]);
    expect((await reserveOutboundSlot(deps(storage), SCOPE)).index).toBe(42);
  });

  it('never seals under the session of another sender, however recent', async () => {
    const { storage } = fakeStorage([
      session({ sessionId: 'theirs', senderId: 'bob', createdAt: NOW + 5_000 }),
      session({ sessionId: 'mine', sentCount: 3 }),
    ]);

    const slot = await reserveOutboundSlot(deps(storage), SCOPE);

    // Bob's session is newer and sits in the same channel; this device holds its seed to READ.
    expect(slot.session.sessionId).toBe('mine');
    expect(slot.index).toBe(3);
  });

  it('never continues a session of its own user minted on ANOTHER device', async () => {
    const { storage } = fakeStorage([
      // Arrives through the distribution group: same user, no `sentCount`, because this device
      // never sealed anything with it. Continuing its indices from a count nobody kept here would
      // put two messages under one key.
      session({ sessionId: 'other-device', sentCount: undefined, createdAt: NOW + 5_000 }),
    ]);
    const d = deps(storage);

    const slot = await reserveOutboundSlot(d, SCOPE);

    expect(slot.minted).toBe(true);
    expect(slot.session.sessionId).not.toBe('other-device');
    expect(d.distribute).toHaveBeenCalledTimes(1);
  });

  it('finds its own session whatever case the caller spells the sender in', async () => {
    const { storage } = fakeStorage([session({ sentCount: 3 })]);

    const slot = await reserveOutboundSlot(deps(storage), { ...SCOPE, senderId: 'Alice' });

    // Missing it would mint on every single send - a community that works while rotating for ever.
    expect(slot.minted).toBe(false);
    expect(slot.index).toBe(3);
  });

  it('hands out distinct indices to sends that race on one channel', async () => {
    const { storage } = fakeStorage([session({ sentCount: 0 })]);
    const d = deps(storage);

    const slots = await Promise.all([
      reserveOutboundSlot(d, SCOPE),
      reserveOutboundSlot(d, SCOPE),
      reserveOutboundSlot(d, SCOPE),
    ]);

    // Two messages under one (session, index) is one AES-GCM key used twice, with no symptom at
    // either end. The serialisation is what makes that unrepresentable.
    expect(slots.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(slots.every((s) => s.session.sessionId === 'sess-1')).toBe(true);
  });

  it('does not stall the channel behind a reservation that threw', async () => {
    const { storage } = fakeStorage();
    const failing = deps(storage, {
      distribute: vi.fn().mockRejectedValue(new Error('offline')),
    });

    const first = reserveOutboundSlot(failing, SCOPE).catch((e) => e);
    const second = reserveOutboundSlot(deps(storage), SCOPE);

    expect(await first).toBeInstanceOf(Error);
    expect((await second).minted).toBe(true);
  });

  it('mints its session in the run it read, at the epoch it read', async () => {
    const { storage } = fakeStorage();
    const slot = await reserveOutboundSlot(deps(storage), SCOPE);
    expect(slot.session.rotationAnchor).toEqual(ANCHOR);
    expect(slot.session.distributionEpoch).toBe(4);
  });

  it('does NOT mint across an Add: it sends the same seed again at the new epoch', async () => {
    const { storage, saved } = fakeStorage([session({ sentCount: 3 })]);
    const newFrame = { groupId: 'dist-group', protoB64: 'bmV3' };
    const d = deps(storage, {
      distributionEpoch: 5,
      readRun: vi.fn().mockResolvedValue({ runId: 'run-A', epoch: 5, epochFingerprint: 'fp-5' }),
      distribute: vi.fn().mockResolvedValue(newFrame),
    });

    const slot = await reserveOutboundSlot(d, SCOPE);

    expect(slot.minted).toBe(false);
    expect(slot.redistributed).toBe(true);
    expect(slot.session.sessionId).toBe('sess-1');
    expect(slot.index).toBe(3);
    expect(d.endorse).not.toHaveBeenCalled();
    // The SAME seed and endorsement go out again, so a device added since can open the session.
    expect(d.distribute).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', seedB64: 'AAAA', v2: V2 })
    );
    expect(saved[0]).toMatchObject({
      sentCount: 4,
      distributionEpoch: 5,
      distributionFrame: newFrame,
      rotationAnchor: { runId: 'run-A', epochFingerprint: 'fp-5', redistributed: true },
    });
  });

  it('keeps the stored session as it was when the re-distribution could not go out', async () => {
    const { storage, saved } = fakeStorage([session({ sentCount: 3 })]);
    const d = deps(storage, {
      readRun: vi.fn().mockResolvedValue({ runId: 'run-A', epoch: 5, epochFingerprint: 'fp-5' }),
      distribute: vi.fn().mockRejectedValue(new Error('offline')),
    });

    await expect(reserveOutboundSlot(d, SCOPE)).rejects.toThrow('offline');
    expect(saved).toHaveLength(0);
  });

  it('mints a new session after a departure', async () => {
    const { storage } = fakeStorage([session({ sentCount: 3 })]);
    const d = deps(storage, {
      distributionEpoch: 5,
      readRun: vi.fn().mockResolvedValue({ runId: 'run-B', epoch: 5, epochFingerprint: 'fp-5' }),
    });

    const slot = await reserveOutboundSlot(d, SCOPE);

    expect(slot.minted).toBe(true);
    expect(slot.session.sessionId).not.toBe('sess-1');
    expect(slot.index).toBe(0);
    expect(slot.session.rotationAnchor?.runId).toBe('run-B');
  });

  it('mints a new session when a device was added AND removed between two sends', async () => {
    // THE CASE A ROSTER COMPARISON MISSES: the tree at the second send is the tree at the first.
    // The tracker saw the Remove go past, so the run is not the one the session was minted in.
    const { storage } = fakeStorage();
    let run: GraineRunReading = RUN;
    const d = deps(storage, { readRun: vi.fn().mockImplementation(async () => run) });

    const first = await reserveOutboundSlot(d, SCOPE);
    run = { runId: 'run-C', epoch: 6, epochFingerprint: 'fp-6' };
    const second = await reserveOutboundSlot(d, SCOPE);

    expect(first.minted && second.minted).toBe(true);
    expect(second.session.sessionId).not.toBe(first.session.sessionId);
  });
});
