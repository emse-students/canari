import type { IStorage, StoredGraineSession } from '$lib/db/types';
import { byNewestSession } from '$lib/db/graineCodec';
import { GRAINE_ROTATE_AFTER_MESSAGES, GRAINE_ROTATE_AFTER_MS } from '$lib/crypto/graineConstants';
import { GraineInputError } from '$lib/crypto/graine';
import {
  graineRotationReason,
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
 * distribution-group epoch that has moved forces a new session (which is the whole of what
 * "somebody left the community" does to the key material).
 */

const NOW = 1_700_000_000_000;
const SCOPE = { workspaceId: 'ws-1', channelId: 'chan-1', senderId: 'alice' };

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
    ...overrides,
  };
}

function deps(storage: IStorage, overrides: Partial<GraineOutboundDeps> = {}): GraineOutboundDeps {
  return {
    storage,
    deviceKeyB64: 'device-key',
    distributionEpoch: 4,
    distribute: vi.fn().mockResolvedValue(undefined),
    now: () => NOW,
    ...overrides,
  };
}

describe('when a session may seal another message', () => {
  const at = { distributionEpoch: 4, now: NOW };

  it('keeps a fresh session minted under the current roster', () => {
    expect(graineRotationReason(session(), at)).toBeNull();
  });

  it('reports every cause by name, not by a yes', () => {
    expect(graineRotationReason(null, at)).toBe('no-session');
    expect(graineRotationReason(session({ distributionEpoch: 3 }), at)).toBe('roster');
    expect(graineRotationReason(session({ sentCount: GRAINE_ROTATE_AFTER_MESSAGES }), at)).toBe(
      'message-count'
    );
    expect(graineRotationReason(session({ createdAt: NOW - GRAINE_ROTATE_AFTER_MS }), at)).toBe(
      'age'
    );
  });

  it('rotates a session that predates the epoch column rather than trusting it', () => {
    // `undefined` is not "epoch 0" and not "still fine": it is a session minted under a roster
    // nobody wrote down, which is exactly the case rotation exists for.
    expect(graineRotationReason(session({ distributionEpoch: undefined }), at)).toBe('roster');
  });

  it('puts the roster ahead of the counters, so a departure is never reported as wear', () => {
    const stale = session({ distributionEpoch: 3, sentCount: GRAINE_ROTATE_AFTER_MESSAGES });
    expect(graineRotationReason(stale, at)).toBe('roster');
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
    expect(d.distribute).toHaveBeenCalledWith(expect.objectContaining({ sentCount: 0 }));
    spySave.mockRestore();
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

  it('mints a new session once the distribution group has moved on', async () => {
    const { storage } = fakeStorage([session({ sentCount: 3, distributionEpoch: 4 })]);
    const d = deps(storage, { distributionEpoch: 5 });

    const slot = await reserveOutboundSlot(d, SCOPE);

    expect(slot.minted).toBe(true);
    expect(slot.session.sessionId).not.toBe('sess-1');
    expect(slot.index).toBe(0);
    expect(d.distribute).toHaveBeenCalledTimes(1);
  });
});
